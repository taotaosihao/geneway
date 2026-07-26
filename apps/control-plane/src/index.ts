import cors from '@fastify/cors';
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deriveTrustedLocalPrincipal } from '@geneway/authorization';
import {
  createTaskInputSchema,
  createChatRunInputSchema,
  acknowledgeBusinessExceptionInputSchema,
  businessExceptionListQuerySchema,
  createExceptionAnalysisTaskInputSchema,
  eventCursorSchema,
  executeTaskInputSchema,
  evidenceProjectionSchema,
  gateACapabilityRouteProjectionSchema,
  gateADocumentExecutionEligibilitySchema,
  gateALiveTaskCreateInputSchema,
  GenewayError,
  isGenewayError,
  taskEventListResponseSchema,
  taskListQuerySchema,
  workflowListQuerySchema,
  type Principal,
} from '@geneway/contracts';
import {
  MAX_MULTIPART_ENVELOPE_BYTES,
  MAX_RAW_UPLOAD_BYTES,
  parseSingleMultipartUpload,
  validateTextUpload,
  type SingleMultipartUpload,
} from '@geneway/ingestion';
import { createObjectStorageFromEnv, type ObjectStorage } from '@geneway/storage';
import {
  FIXTURE_CONTENT_HASH,
  FIXTURE_EXCERPT,
  FIXTURE_REF,
  FIXTURE_VERSION,
  extractVerifiedDocumentEvidence,
} from '@geneway/evidence';
import { ControlPlaneRepository } from './repository.js';
import { ChatRepository } from './chat-repository.js';
import { ArtifactRepository } from './artifact-repository.js';
import type { ValidatedArtifactUpload } from './artifact-repository.js';
import { ArtifactService, type ArtifactServiceHooks } from './artifact-service.js';
import { BusinessExceptionRepository } from './business-exception-repository.js';
import { GateALiveRepository } from './gate-a-live-repository.js';

function validateArtifactUpload(upload: SingleMultipartUpload): ValidatedArtifactUpload {
  const lowerName = upload.fileName.toLowerCase();
  if (lowerName.endsWith('.txt') || lowerName.endsWith('.md')) return validateTextUpload(upload);
  if (!/^[^/\\\0]{1,120}$/u.test(upload.fileName) || upload.fileName.startsWith('.') || upload.fileName.includes('..')
    || upload.bytes.byteLength < 1 || upload.bytes.byteLength > MAX_RAW_UPLOAD_BYTES) {
    throw new GenewayError('INVALID_DOCUMENT_UPLOAD', 'Document file name or size is invalid', 422);
  }
  const pdf = lowerName.endsWith('.pdf') && upload.mediaType === 'application/pdf'
    && Buffer.from(upload.bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  const docx = lowerName.endsWith('.docx')
    && upload.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    && upload.bytes[0] === 0x50 && upload.bytes[1] === 0x4b && upload.bytes[2] === 0x03 && upload.bytes[3] === 0x04;
  if (!pdf && !docx) throw new GenewayError('UNSUPPORTED_DOCUMENT_FORMAT', 'Document extension, MIME type, and signature must match', 415);
  return {
    bytes: upload.bytes, displayName: upload.fileName,
    mediaType: pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: pdf ? 'pdf' : 'docx', sizeBytes: upload.bytes.byteLength,
    contentSha256: createHash('sha256').update(upload.bytes).digest('hex'), simulationProfile: null,
    profileRegistryVersion: 'gate0.2a-profile-registry/1',
  };
}

export { StorageReconciler } from './storage-reconciler.js';
export type { StorageReconciliationFinding, StorageReconciliationResult } from './storage-reconciler.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : '';
};

const liveDocumentTaskCandidateSchema = z.object({
  conversationId: z.string().min(1),
  capabilityId: z.literal('solution.analysis.v1'),
  inputRef: z.object({
    kind: z.literal('document_snapshot'),
    documentSnapshotId: z.string().min(1),
  }).strict(),
}).passthrough();

const bearerMatches = (header: string | undefined, expected: string): boolean => {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
};

const invocationTokenAudience = (token: string): string | null => {
  const [encoded, signature, extra] = token.split('.');
  if (encoded === undefined || signature === undefined || extra !== undefined
    || !/^[A-Za-z0-9_-]+$/u.test(encoded) || Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    const parsed = z.object({ aud: z.string().min(1).max(200) }).passthrough().safeParse(payload);
    return parsed.success ? parsed.data.aud : null;
  } catch {
    return null;
  }
};

const requireMutationOrigin = (request: FastifyRequest, allowedOrigins: ReadonlySet<string>): void => {
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new GenewayError('ORIGIN_NOT_ALLOWED', 'Cross-origin writes are not allowed', 403);
  }
};

export type PrincipalResolver = (request: FastifyRequest) => Principal;
export type ControlPlane = Readonly<{
  app: FastifyInstance;
  repository: ControlPlaneRepository;
  artifactRepository: ArtifactRepository;
  artifactService: ArtifactService | null;
  chatRepository: ChatRepository;
  businessExceptionRepository: BusinessExceptionRepository;
  gateALiveRepository: GateALiveRepository | null;
}>;

export async function createControlPlane(options: Readonly<{
  databaseUrl: string;
  cursorHmacSecret?: string;
  logger?: boolean;
  allowedOrigins?: readonly string[];
  objectStorage?: ObjectStorage | null;
  principalResolver?: PrincipalResolver;
  artifactServiceHooks?: ArtifactServiceHooks;
  chatRouteAvailable?: () => Promise<boolean>;
  modelGatewayAuthority?: Readonly<{ serviceToken: string; invocationTokenSecret: string }>;
  liveValidationRunId?: string;
  gateALiveValidationRunId?: string;
  chatReaperIntervalMs?: number;
}>): Promise<ControlPlane> {
  const cursorHmacSecret = options.cursorHmacSecret ?? process.env.GENEWAY_CURSOR_HMAC_SECRET;
  if (cursorHmacSecret === undefined) throw new Error('GENEWAY_CURSOR_HMAC_SECRET is required');
  const repository = new ControlPlaneRepository(options.databaseUrl, cursorHmacSecret);
  const artifactRepository = new ArtifactRepository(repository.pool);
  const chatRepository = new ChatRepository(repository.pool, options.liveValidationRunId);
  if (options.gateALiveValidationRunId !== undefined && options.modelGatewayAuthority === undefined) {
    throw new Error('Gate A live validation requires Model Gateway authority');
  }
  const gateALiveRepository = options.gateALiveValidationRunId === undefined
    ? null
    : new GateALiveRepository(repository.pool, options.modelGatewayAuthority!.invocationTokenSecret, options.gateALiveValidationRunId);
  const businessExceptionRepository = new BusinessExceptionRepository(repository.pool, cursorHmacSecret);
  const objectStorage = options.objectStorage === undefined ? createObjectStorageFromEnv() : options.objectStorage;
  const artifactServiceHooks: ArtifactServiceHooks = {
    ...options.artifactServiceHooks,
    ...(gateALiveRepository === null ? {} : { liveCanonicalIngest: true, resolveLiveExecutionEligibility: async (input) => {
      const modelRouteAvailable = options.chatRouteAvailable === undefined
        ? false
        : await options.chatRouteAvailable();
      const capabilityRoute = gateACapabilityRouteProjectionSchema.parse(await gateALiveRepository.getCapabilityRoute(
        input.principal,
        modelRouteAvailable,
        options.artifactServiceHooks?.parserSandbox !== undefined,
      ));
      if (capabilityRoute.status !== 'internal') {
        return gateADocumentExecutionEligibilitySchema.parse({
          route: 'not_open',
          eligible: false,
          reason: capabilityRoute.reason === 'PARSER_AUTHORITY_UNAVAILABLE'
            ? 'PARSER_AUTHORITY_UNAVAILABLE'
            : capabilityRoute.reason === 'DATA_ROUTE_NOT_ALLOWED'
              ? 'DATA_ROUTE_NOT_ALLOWED'
              : 'LIVE_RELEASE_NOT_OPEN',
        });
      }
      const eligibility = gateADocumentExecutionEligibilitySchema.parse(
        await gateALiveRepository.getDocumentExecutionEligibility(input.principal, input.documentSnapshotId),
      );
      if (eligibility.route !== 'live') return eligibility;
      if (eligibility.parserManifestId !== input.parserManifestId
        || eligibility.parserDigest !== input.parserDigest
        || eligibility.extractionVersion !== input.extractionVersion
        || eligibility.canonicalTextSha256 !== input.canonicalTextSha256) {
        return gateADocumentExecutionEligibilitySchema.parse({
          route: 'not_open', eligible: false, reason: 'CANONICAL_REPRESENTATION_UNAVAILABLE',
        });
      }
      return eligibility;
    } }),
  };
  const artifactService = objectStorage === null
    ? null
    : new ArtifactService(artifactRepository, objectStorage, artifactServiceHooks);
  await repository.ensureSystemSeed();
  await gateALiveRepository?.ensureLiveAuthority();
  const allowedOrigins = new Set(options.allowedOrigins ?? ['http://localhost:3200', 'http://127.0.0.1:3200']);
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false, bodyLimit: MAX_MULTIPART_ENVELOPE_BYTES });
  const resolvePrincipal = options.principalResolver ?? ((request: FastifyRequest) => deriveTrustedLocalPrincipal(request.ip));
  app.decorateRequest('principal', {
    getter(this: FastifyRequest) {
      return resolvePrincipal(this);
    },
  });
  app.addContentTypeParser('multipart/form-data', (request, payload, done) => {
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string') {
      done(new GenewayError('MULTIPART_REQUIRED', 'Upload must use multipart/form-data', 415));
      return;
    }
    void parseSingleMultipartUpload({
      stream: payload,
      headers: { ...request.headers, 'content-type': contentType },
      maximumEnvelopeBytes: MAX_MULTIPART_ENVELOPE_BYTES,
      maximumFileBytes: MAX_RAW_UPLOAD_BYTES,
    }).then((body) => done(null, body), done);
  });
  await app.register(cors, {
    origin: [...allowedOrigins],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'idempotency-key'],
  });

  app.addHook('onRequest', (request, _reply, done) => {
    void request.principal;
    requireMutationOrigin(request, allowedOrigins);
    done();
  });

  app.setErrorHandler(async (error, request, reply) => {
    const route = request.routeOptions.url;
    const params = request.params as Readonly<{ id?: unknown }> | undefined;
    const resourceId = typeof params?.id === 'string' && params.id.length <= 200 ? params.id : 'unknown';
    const artifactOperation = route === '/api/conversations/:id/uploads'
      ? { operation: 'upload', resourceType: 'conversation', resourceId }
      : route === '/api/artifacts/:id/download'
        ? { operation: 'download', resourceType: 'artifact', resourceId }
        : null;
    const fastifyError = error as Error & Readonly<{ code?: string; statusCode?: number }>;
    const normalized = isGenewayError(error)
      ? { code: error.code, message: error.message, statusCode: error.statusCode, details: error.details ?? null }
      : error instanceof z.ZodError
        ? { code: 'INVALID_INPUT', message: 'Request does not match the contract', statusCode: 400, details: { issues: error.issues } }
        : fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
          ? { code: 'UPLOAD_ENVELOPE_TOO_LARGE', message: 'Multipart request exceeds the maximum envelope size', statusCode: 413, details: null }
          : fastifyError.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
            ? { code: 'MULTIPART_REQUIRED', message: 'Upload must use multipart/form-data', statusCode: 415, details: null }
            : { code: 'INTERNAL_ERROR', message: 'Unexpected server error', statusCode: 500, details: null };
    if (artifactOperation !== null) {
      try {
        let auditPrincipal: Principal | null = null;
        try {
          auditPrincipal = request.principal;
        } catch {
          // An unauthenticated request has no trusted principal to attribute in the tenant audit ledger.
        }
        if (auditPrincipal === null) throw new GenewayError('AUDIT_PRINCIPAL_UNAVAILABLE', 'No trusted principal is available for audit attribution', 401);
        const auditReasonCode = artifactOperation.operation === 'download' && normalized.code === 'ARTIFACT_NOT_FOUND'
          ? 'ARTIFACT_NOT_FOUND_OR_FORBIDDEN'
          : normalized.code;
        await artifactRepository.recordAudit(
          auditPrincipal,
          `artifact.${artifactOperation.operation}.${normalized.statusCode >= 500 ? 'failed' : 'denied'}`,
          artifactOperation.resourceType,
          artifactOperation.resourceId,
          normalized.statusCode >= 500 ? 'failed' : 'denied',
          auditReasonCode,
          { requestId: request.id },
        );
      } catch (auditError) {
        if (isGenewayError(auditError) && auditError.code === 'AUDIT_PRINCIPAL_UNAVAILABLE') {
          if (isGenewayError(error)) {
            void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
            return;
          }
        }
        app.log.error(auditError);
        void reply.status(500).send({ error: { code: 'AUDIT_WRITE_FAILED', message: 'The request could not be audited' } });
        return;
      }
    }
    if (isGenewayError(error)) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ error: { code: 'INVALID_INPUT', message: 'Request does not match the contract', issues: error.issues } });
      return;
    }
    if (normalized.code !== 'INTERNAL_ERROR') {
      void reply.status(normalized.statusCode).send({ error: { code: normalized.code, message: normalized.message, details: normalized.details } });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
  });

  app.get('/health', () => ({ ok: true, service: 'geneway-control-plane' }));

  if (options.modelGatewayAuthority !== undefined) {
    app.post('/internal/model-gateway/v1/introspect', async (request, reply) => {
      if (request.headers.origin !== undefined || !bearerMatches(request.headers.authorization, options.modelGatewayAuthority!.serviceToken)) {
        return reply.status(401).send({ active: false });
      }
      const body = z.object({ invocationToken: z.string().min(40).max(8_192) }).strict().parse(request.body);
      const audience = invocationTokenAudience(body.invocationToken);
      const active = audience === 'local-model-gateway'
        ? await chatRepository.consumeInvocationToken(body.invocationToken, options.modelGatewayAuthority!.invocationTokenSecret)
        : audience === 'local-model-gateway-analysis' && gateALiveRepository !== null
          ? await gateALiveRepository.consumeAnalysisInvocationToken(body.invocationToken)
          : false;
      return active ? { active: true } : reply.status(401).send({ active: false });
    });
  }

  app.post('/api/conversations', async (request, reply) => {
    const result = await repository.createConversation(request.principal, idempotencyKey(request));
    return reply.status(201).send(result);
  });

  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ body: z.string().min(1).max(10_000) }).strict().parse(request.body);
    const result = await repository.addUserMessage(request.principal, params.id, body.body, idempotencyKey(request));
    return reply.status(201).send(result);
  });

  app.get('/api/conversations/:id', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return chatRepository.getConversation(request.principal, params.id);
  });

  app.get('/api/business-exceptions', async (request) => {
    const query = businessExceptionListQuerySchema.parse(request.query);
    return businessExceptionRepository.list(request.principal, query);
  });

  app.get('/api/business-exceptions/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).strict().parse(request.params);
    const result = await businessExceptionRepository.get(request.principal, params.id);
    reply.header('etag', `"${String(result.aggregateVersion)}"`);
    reply.header('cache-control', 'private, no-store');
    return result;
  });

  app.post('/api/business-exceptions/:id/acknowledge', async (request) => {
    const params = z.object({ id: z.string().min(1) }).strict().parse(request.params);
    const input = acknowledgeBusinessExceptionInputSchema.parse(request.body);
    return businessExceptionRepository.acknowledge(request.principal, params.id, input.aggregateVersion);
  });

  app.post('/api/business-exceptions/:id/analysis-task', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).strict().parse(request.params);
    const input = createExceptionAnalysisTaskInputSchema.parse(request.body);
    const result = await businessExceptionRepository.createAnalysisTask(request.principal, params.id, input);
    return reply.status(201).send(result);
  });

  app.post('/api/conversations/:id/chat-runs', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = createChatRunInputSchema.parse(request.body);
    await chatRepository.assertInternalRelease(request.principal);
    if (options.chatRouteAvailable === undefined || !await options.chatRouteAvailable()) {
      throw new GenewayError('MODEL_ROUTE_UNAVAILABLE', '真实模型通道未配置或不可用', 503);
    }
    const result = await chatRepository.createChatRun(request.principal, params.id, input, idempotencyKey(request));
    return reply.status(202).send(result);
  });

  app.post('/api/conversations/:conversationId/chat-runs/:modelInvocationId/cancel', async (request) => {
    const params = z.object({
      conversationId: z.string().min(1), modelInvocationId: z.string().min(1),
    }).parse(request.params);
    return chatRepository.cancelChatRun(
      request.principal, params.conversationId, params.modelInvocationId, idempotencyKey(request),
    );
  });

  app.get('/api/conversations/:conversationId/chat-runs/:modelInvocationId/events', async (request, reply) => {
    const params = z.object({ conversationId: z.string().min(1), modelInvocationId: z.string().min(1) }).parse(request.params);
    const query = z.object({ cursor: eventCursorSchema.default(0) }).strict().parse(request.query);
    const events = await chatRepository.getEvents(request.principal, params.conversationId, params.modelInvocationId, query.cursor);
    if (request.headers.accept?.includes('text/event-stream') === true) {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      for (const event of events) {
        reply.raw.write(`id: ${String(event.cursor)}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      reply.raw.end();
      return reply;
    }
    return { events };
  });

  app.post('/api/conversations/:id/uploads', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (artifactService === null) throw new GenewayError('STORAGE_NOT_CONFIGURED', 'Artifact storage is not configured', 503);
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('multipart/form-data')) {
      throw new GenewayError('MULTIPART_REQUIRED', 'Upload must use multipart/form-data', 415);
    }
    const uploaded = request.body as SingleMultipartUpload;
    const result = await artifactService.ingest({
      principal: request.principal,
      conversationId: params.id,
      idempotencyKey: idempotencyKey(request),
      upload: validateArtifactUpload(uploaded),
    });
    return reply.status(201).send(result);
  });

  app.get('/api/conversations/:id/document-snapshots', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (artifactService === null) throw new GenewayError('STORAGE_NOT_CONFIGURED', 'Artifact storage is not configured', 503);
    return { documentSnapshots: await artifactService.listSnapshots(request.principal, params.id) };
  });

  app.get('/api/capabilities', async () => {
    const chatAvailable = options.chatRouteAvailable !== undefined
      && await chatRepository.isInternalRelease('tenant_local')
      && await options.chatRouteAvailable();
    return [{
      id: 'xiaowei.chat.v1', version: 1, name: '小纬聊天', status: chatAvailable ? 'internal' : 'NOT_OPEN',
      simulation: false, toolChoice: 'none', dataClasses: ['C0', 'C1'],
    }, {
      id: 'solution.analysis.v1', version: 1, name: '方案分析', fixtureOnly: true,
      simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false,
    }];
  });

  app.get('/api/capabilities/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    if (params.id === 'xiaowei.chat.v1') {
      const available = options.chatRouteAvailable !== undefined
        && await chatRepository.isInternalRelease('tenant_local')
        && await options.chatRouteAvailable();
      if (!available) return reply.status(503).send({ error: { code: 'MODEL_ROUTE_UNAVAILABLE', message: '真实模型通道未配置或不可用' } });
      return { id: params.id, version: 1, logicalModelPolicy: 'general.chat.standard', toolChoice: 'none', status: 'internal' };
    }
    if (params.id !== 'solution.analysis.v1') return reply.status(422).send({ error: { code: 'NOT_OPEN', message: 'Capability is not open in Gate 0.1' } });
    if (gateALiveRepository !== null) {
      const modelRouteAvailable = options.chatRouteAvailable !== undefined && await options.chatRouteAvailable();
      return gateALiveRepository.getCapabilityRoute(
        request.principal,
        modelRouteAvailable,
        options.artifactServiceHooks?.parserSandbox !== undefined,
      );
    }
    return { id: params.id, version: 1, workflowNodeCount: 7, fixtureRef: 'fixture:solution-analysis:v1', simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false };
  });

  app.get('/api/fixtures/solution-analysis-v1', () => ({
    ref: FIXTURE_REF,
    version: FIXTURE_VERSION,
    name: '脱敏制造执行需求说明',
    description: '预置只读材料，用于验证方案分析、质量追溯与证据引用。',
    excerpt: FIXTURE_EXCERPT,
    contentHash: FIXTURE_CONTENT_HASH,
    simulation: true,
    runtimeMode: 'fake',
    businessDecisionAllowed: false,
  }));

  app.get('/api/experts', async (request, reply) => {
    const query = z.object({ capabilityId: z.string() }).parse(request.query);
    if (query.capabilityId !== 'solution.analysis.v1') return reply.status(422).send({ error: { code: 'NOT_OPEN', message: 'Capability is not open' } });
    return {
      catalogVersionId: 'expert_catalog_solution_v1_1',
      experts: [{ id: 'expert.solution.architect', name: '方案专家', healthy: true }],
      teams: [{ id: 'team.solution.core', name: '方案专家团', expertIds: ['expert.solution.architect'], healthy: true }],
    };
  });

  app.post('/api/business-tasks', async (request, reply) => {
    const liveCandidate = liveDocumentTaskCandidateSchema.safeParse(request.body);
    if (liveCandidate.success && gateALiveRepository !== null) {
      const source = await repository.pool.query<{ simulation_profile: string | null }>(`SELECT snapshot.simulation_profile
        FROM document_snapshots snapshot
        JOIN conversations conversation ON conversation.tenant_id=snapshot.tenant_id
          AND conversation.id=snapshot.conversation_id
        WHERE snapshot.tenant_id=$1 AND snapshot.id=$2 AND conversation.user_id=$3`, [
        request.principal.tenantId, liveCandidate.data.inputRef.documentSnapshotId, request.principal.userId,
      ]);
      if (source.rows[0]?.simulation_profile === null || source.rowCount === 0) {
        const liveInput = gateALiveTaskCreateInputSchema.parse(request.body);
        const modelRouteAvailable = options.chatRouteAvailable === undefined
          ? false
          : await options.chatRouteAvailable();
        const capabilityRoute = gateACapabilityRouteProjectionSchema.parse(await gateALiveRepository.getCapabilityRoute(
          request.principal,
          modelRouteAvailable,
          options.artifactServiceHooks?.parserSandbox !== undefined,
        ));
        if (capabilityRoute.status !== 'internal') {
          return reply.status(422).send({ error: { code: 'NOT_OPEN', message: 'Capability is not open' } });
        }
        const result = await gateALiveRepository.createLiveTaskProjection(request.principal, {
          conversationId: liveInput.conversationId,
          documentSnapshotId: liveInput.inputRef.documentSnapshotId,
          idempotencyKey: idempotencyKey(request),
          expertTarget: liveInput.expertTarget,
        });
        return reply.status(201).send(result);
      }
    }
    const input = createTaskInputSchema.parse(request.body);
    const result = await repository.createTask(request.principal, input, idempotencyKey(request));
    return reply.status(201).send(result);
  });

  app.get('/api/business-tasks', async (request) => {
    const query = taskListQuerySchema.parse(request.query);
    return repository.listTasks(request.principal, query);
  });

  app.get('/api/business-tasks/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    if (gateALiveRepository !== null && await gateALiveRepository.isLiveTask(request.principal, params.id)) {
      return gateALiveRepository.getLiveTask(request.principal, params.id);
    }
    return repository.getTask(request.principal, params.id);
  });

  app.get('/api/business-tasks/:id/events', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({
      after: eventCursorSchema.optional(),
      afterCursor: eventCursorSchema.optional(),
    }).strict().refine((value) => value.after === undefined || value.afterCursor === undefined, {
      message: 'Use only one event cursor parameter',
    }).parse(request.query);
    const live = gateALiveRepository !== null && await gateALiveRepository.isLiveTask(request.principal, params.id);
    const liveResponse = live
      ? await gateALiveRepository.getLiveEvents(request.principal, params.id, query.after ?? query.afterCursor ?? 0)
      : null;
    const events = live
      ? (liveResponse as Readonly<{ events: readonly Readonly<{ cursor: number; eventType: string }>[] }>).events
      : await repository.getEvents(request.principal, params.id, query.after ?? query.afterCursor ?? 0);
    if (request.headers.accept?.includes('text/event-stream') === true) {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const event of events) reply.raw.write(`id: ${String(event.cursor)}\nevent: ${live ? event.eventType : 'task-event'}\ndata: ${JSON.stringify(event)}\n\n`);
      reply.raw.end();
      return reply;
    }
    return live ? liveResponse : taskEventListResponseSchema.parse({ events });
  });

  app.get('/api/workflow-versions', async (request) => {
    const query = workflowListQuerySchema.parse(request.query);
    return repository.listWorkflows(request.principal, query);
  });

  app.get('/api/workflow-versions/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    if (gateALiveRepository !== null && await gateALiveRepository.isLiveWorkflow(request.principal, params.id)) {
      return gateALiveRepository.getLiveWorkflow(request.principal, params.id);
    }
    return repository.getWorkflow(request.principal, params.id);
  });

  app.get('/api/approvals/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    if (gateALiveRepository !== null) {
      const liveIdentity = await repository.pool.query(`SELECT 1 FROM approval_versions approval
        JOIN business_tasks task ON task.tenant_id=approval.tenant_id AND task.id=approval.business_task_id
        WHERE approval.tenant_id=$1 AND approval.id=$2 AND task.record_variant='business-task.live/1'`, [
        request.principal.tenantId, params.id,
      ]);
      const live = await repository.pool.query<{ business_task_id: string }>(`SELECT approval.business_task_id
        FROM approval_versions approval
        JOIN business_tasks task ON task.tenant_id=approval.tenant_id AND task.id=approval.business_task_id
        JOIN document_snapshots snapshot ON snapshot.tenant_id=task.tenant_id
          AND snapshot.id=task.input_document_snapshot_id AND snapshot.conversation_id=task.conversation_id
        JOIN artifacts artifact ON artifact.tenant_id=snapshot.tenant_id AND artifact.id=task.input_artifact_id
          AND artifact.id=snapshot.artifact_id AND artifact.content_sha256=task.input_artifact_sha256
        JOIN artifact_states state ON state.tenant_id=artifact.tenant_id AND state.artifact_id=artifact.id
        JOIN document_snapshot_canonical_representations canonical ON canonical.tenant_id=snapshot.tenant_id
          AND canonical.document_snapshot_id=snapshot.id AND canonical.parser_manifest_id=task.input_parser_manifest_id
          AND canonical.parser_digest=task.input_parser_digest
          AND canonical.extraction_version=task.input_extraction_version
          AND canonical.canonical_text_sha256=task.input_canonical_text_sha256
        JOIN parser_manifests parser ON parser.tenant_id=canonical.tenant_id AND parser.id=canonical.parser_manifest_id
          AND parser.manifest_digest=canonical.parser_digest
        WHERE approval.tenant_id=$1 AND approval.id=$2
          AND task.record_variant='business-task.live/1' AND task.requester_id=$3
          AND EXISTS (SELECT 1 FROM roles role_binding WHERE role_binding.tenant_id=task.tenant_id
            AND role_binding.user_id=$3 AND role_binding.role='solution_reviewer')
          AND EXISTS (SELECT 1 FROM conversations owned_conversation
            WHERE owned_conversation.tenant_id=task.tenant_id AND owned_conversation.id=task.conversation_id
              AND owned_conversation.user_id=$3)
          AND state.availability='active' AND state.integrity='verified'
          AND state.retention_status='active' AND state.retention_expires_at>now()
          AND state.reconcile_status='in_sync'`, [request.principal.tenantId, params.id, request.principal.userId]);
      const row = live.rows[0];
      if (row !== undefined) {
        const task = await gateALiveRepository.getLiveTask(request.principal, row.business_task_id) as Readonly<{
          approval: Readonly<{ id: string; version: number; status: string; subjectDigest: string }>;
        }>;
        if (task.approval.id !== params.id) throw new GenewayError('APPROVAL_NOT_FOUND', 'Approval was not found', 404);
        return { id: task.approval.id, businessTaskId: row.business_task_id,
          version: task.approval.version, status: task.approval.status, subjectDigest: task.approval.subjectDigest };
      }
      if (liveIdentity.rowCount === 1) throw new GenewayError('APPROVAL_NOT_FOUND', 'Approval was not found', 404);
    }
    return repository.getApproval(request.principal, params.id);
  });

  app.post('/api/approvals/:id/decisions', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approved', 'rejected']) }).strict().parse(request.body);
    if (gateALiveRepository !== null) {
      const live = await repository.pool.query(`SELECT 1 FROM approval_versions approval
        JOIN business_tasks task ON task.tenant_id=approval.tenant_id AND task.id=approval.business_task_id
        WHERE approval.tenant_id=$1 AND approval.id=$2 AND task.record_variant='business-task.live/1'`, [
        request.principal.tenantId, params.id,
      ]);
      if (live.rowCount === 1) return gateALiveRepository.decideLiveApproval(
        request.principal, params.id, body.decision, idempotencyKey(request),
      );
    }
    return repository.decideApproval(request.principal, params.id, body.decision, idempotencyKey(request));
  });

  app.post('/api/business-tasks/:id/execute', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const input = executeTaskInputSchema.parse(request.body);
    if (gateALiveRepository !== null && await gateALiveRepository.isLiveTask(request.principal, params.id)) {
      return gateALiveRepository.executeLiveTask(request.principal, params.id, input, idempotencyKey(request));
    }
    return repository.enqueueExecution(request.principal, params.id, input, idempotencyKey(request));
  });

  app.post('/api/business-tasks/:id/cancel', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    if (gateALiveRepository !== null && await gateALiveRepository.isLiveTask(request.principal, params.id)) {
      return gateALiveRepository.cancelLiveTask(request.principal, params.id, idempotencyKey(request));
    }
    return repository.cancelTask(request.principal, params.id, idempotencyKey(request));
  });

  app.get('/api/claims/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.getClaim(request.principal, params.id);
  });

  app.get('/api/evidence/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    if (gateALiveRepository !== null) {
      const live = await repository.pool.query(`SELECT 1 FROM gate_a_live_evidence
        WHERE tenant_id=$1 AND id=$2 AND record_variant='evidence.live/1'`, [request.principal.tenantId, params.id]);
      if (live.rowCount === 1) return gateALiveRepository.getLiveEvidence(request.principal, params.id);
    }
    const raw = await repository.getEvidenceMetadata(request.principal, params.id);
    const source = raw.source as Readonly<Record<string, unknown>>;
    let excerpt: string;
    if (source.kind === 'legacy_fixture') {
      if (source.fixtureRef !== FIXTURE_REF || source.fixtureVersion !== FIXTURE_VERSION
        || source.sourceId !== `${FIXTURE_REF}#requirements` || source.excerptSha256 !== FIXTURE_CONTENT_HASH) {
        throw new GenewayError('EVIDENCE_SOURCE_INVALID', 'Legacy Evidence source is invalid', 409);
      }
      excerpt = FIXTURE_EXCERPT;
    } else if (source.kind === 'document_snapshot') {
      if (artifactService === null) throw new GenewayError('STORAGE_NOT_CONFIGURED', 'Artifact storage is not configured', 503);
      const artifactId = z.string().min(1).parse(source.artifactId);
      const downloaded = await artifactService.download(request.principal, artifactId);
      const verified = extractVerifiedDocumentEvidence({
        rawBytes: downloaded.bytes,
        snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).parse(source.snapshotSha256),
        startByte: z.number().int().nonnegative().parse(source.startByte),
        endByteExclusive: z.number().int().positive().parse(source.endByteExclusive),
      });
      if (verified.excerptSha256 !== raw.excerpt_sha256 || verified.excerpt !== raw.source_excerpt) {
        throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Evidence no longer matches its immutable source', 409);
      }
      excerpt = verified.excerpt;
    } else if (source.kind === 'business_exception_snapshot') {
      const businessExceptionId = z.string().min(1).parse(source.businessExceptionId);
      const sourceVersionId = z.string().min(1).parse(source.sourceVersionId);
      const sourceSha256 = z.string().regex(/^[a-f0-9]{64}$/u).parse(source.sourceSha256);
      const jsonPointer = z.string().regex(/^\/values\/[^/]+$/u).parse(source.jsonPointer);
      const snapshot = await repository.pool.query<{ canonical_bytes: Buffer }>(`SELECT snapshot.canonical_bytes
        FROM business_exception_source_snapshots snapshot
        WHERE snapshot.tenant_id=$1 AND snapshot.business_exception_id=$2
          AND snapshot.source_version_id=$3 AND snapshot.canonical_sha256=$4`, [
        request.principal.tenantId, businessExceptionId, sourceVersionId, sourceSha256,
      ]);
      const bytes = snapshot.rows[0]?.canonical_bytes;
      if (bytes === undefined || createHash('sha256').update(bytes).digest('hex') !== sourceSha256) {
        throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Evidence no longer matches its immutable exception source', 409);
      }
      const key = jsonPointer.slice('/values/'.length).replaceAll('~1', '/').replaceAll('~0', '~');
      const parsed = JSON.parse(bytes.toString('utf8')) as Readonly<{ values?: Readonly<Record<string, unknown>> }>;
      const value = parsed.values?.[key];
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) {
        throw new GenewayError('EVIDENCE_SOURCE_INVALID', 'Evidence pointer is outside the scalar exception facts allowlist', 409);
      }
      excerpt = JSON.stringify(value);
      const valueSha256 = createHash('sha256').update(excerpt).digest('hex');
      if (valueSha256 !== source.valueSha256 || valueSha256 !== raw.excerpt_sha256 || excerpt !== raw.source_excerpt) {
        throw new GenewayError('EVIDENCE_INTEGRITY_FAILED', 'Evidence value no longer matches its immutable exception source', 409);
      }
    } else {
      throw new GenewayError('EVIDENCE_SOURCE_INVALID', 'Evidence source is not supported', 409);
    }
    const lineage = await repository.pool.query<{ id: string }>(`SELECT id FROM lineage_records
      WHERE tenant_id=$1 AND business_task_id=$2 AND (from_id=$3 OR to_id=$3) ORDER BY created_at,id`, [
      request.principal.tenantId, raw.business_task_id, params.id,
    ]);
    return evidenceProjectionSchema.parse({
      id: raw.id,
      source,
      excerpt,
      excerptSha256: raw.excerpt_sha256,
      resourceScope: raw.resource_scope,
      dataClass: raw.data_class,
      audience: {
        kind: 'private_conversation',
        conversationId: z.string().startsWith('conversation:').parse(raw.audience).slice('conversation:'.length),
      },
      lineageRecordIds: lineage.rows.map((row) => row.id),
    });
  });

  app.get('/api/artifacts/:id/download', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (artifactService === null) throw new GenewayError('STORAGE_NOT_CONFIGURED', 'Artifact storage is not configured', 503);
    const result = await artifactService.download(request.principal, params.id);
    const fallbackName = result.artifact.mediaType === 'text/markdown' ? 'document.md' : 'document.txt';
    reply.header('content-type', result.artifact.mediaType);
    reply.header('content-length', String(result.bytes.byteLength));
    reply.header('content-disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(result.artifact.displayName)}`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return reply.send(Buffer.from(result.bytes));
  });

  const notOpen = async (_request: FastifyRequest, reply: FastifyReply) => reply.status(422).send({ error: { code: 'NOT_OPEN', message: 'This capability is not open in Gate 0.1' } });
  app.post('/api/uploads', notOpen);
  app.all('/api/runtime/:kind', notOpen);

  const chatReaperIntervalMs = options.chatReaperIntervalMs ?? 250;
  if (!Number.isInteger(chatReaperIntervalMs) || chatReaperIntervalMs < 20 || chatReaperIntervalMs > 10_000) {
    throw new Error('Chat reaper interval must be an integer between 20 and 10000 milliseconds');
  }
  let chatReaperRun: Promise<void> | null = null;
  const chatReaperTimer = setInterval(() => {
    if (chatReaperRun !== null) return;
    chatReaperRun = chatRepository.settleExpiredChatTurns()
      .then(() => undefined)
      .catch((error: unknown) => { app.log.error(error); })
      .finally(() => { chatReaperRun = null; });
  }, chatReaperIntervalMs);
  chatReaperTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(chatReaperTimer);
    await chatReaperRun;
    await repository.close();
  });
  return { app, repository, artifactRepository, artifactService, chatRepository,
    businessExceptionRepository, gateALiveRepository };
}

export { ControlPlaneRepository } from './repository.js';
export { ArtifactRepository } from './artifact-repository.js';
export { ArtifactService } from './artifact-service.js';
export { ChatRepository } from './chat-repository.js';
export { GateALiveRepository } from './gate-a-live-repository.js';
export { BusinessExceptionRepository, GATE_0_2B_EXCEPTION_FIXTURES } from './business-exception-repository.js';
export { createWorkerCommandApp, WorkerCommandService } from './worker-command-server.js';
