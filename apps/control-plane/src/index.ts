import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deriveTrustedLocalPrincipal } from '@geneway/authorization';
import {
  createTaskInputSchema,
  createChatRunInputSchema,
  eventCursorSchema,
  evidenceProjectionSchema,
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
import { ArtifactService, type ArtifactServiceHooks } from './artifact-service.js';

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

const bearerMatches = (header: string | undefined, expected: string): boolean => {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
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
}>): Promise<ControlPlane> {
  const cursorHmacSecret = options.cursorHmacSecret ?? process.env.GENEWAY_CURSOR_HMAC_SECRET;
  if (cursorHmacSecret === undefined) throw new Error('GENEWAY_CURSOR_HMAC_SECRET is required');
  const repository = new ControlPlaneRepository(options.databaseUrl, cursorHmacSecret);
  const artifactRepository = new ArtifactRepository(repository.pool);
  const chatRepository = new ChatRepository(repository.pool, options.liveValidationRunId);
  const objectStorage = options.objectStorage === undefined ? createObjectStorageFromEnv() : options.objectStorage;
  const artifactService = objectStorage === null
    ? null
    : new ArtifactService(artifactRepository, objectStorage, options.artifactServiceHooks);
  await repository.ensureSystemSeed();
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
      const active = await chatRepository.consumeInvocationToken(body.invocationToken, options.modelGatewayAuthority!.invocationTokenSecret);
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
      upload: validateTextUpload(uploaded),
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
    const events = await repository.getEvents(request.principal, params.id, query.after ?? query.afterCursor ?? 0);
    if (request.headers.accept?.includes('text/event-stream') === true) {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const event of events) reply.raw.write(`id: ${String(event.cursor)}\nevent: task-event\ndata: ${JSON.stringify(event)}\n\n`);
      reply.raw.end();
      return reply;
    }
    return taskEventListResponseSchema.parse({ events });
  });

  app.get('/api/workflow-versions', async (request) => {
    const query = workflowListQuerySchema.parse(request.query);
    return repository.listWorkflows(request.principal, query);
  });

  app.get('/api/workflow-versions/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.getWorkflow(request.principal, params.id);
  });

  app.get('/api/approvals/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.getApproval(request.principal, params.id);
  });

  app.post('/api/approvals/:id/decisions', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approved', 'rejected']) }).strict().parse(request.body);
    return repository.decideApproval(request.principal, params.id, body.decision, idempotencyKey(request));
  });

  app.post('/api/business-tasks/:id/execute', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.enqueueExecution(request.principal, params.id, idempotencyKey(request));
  });

  app.post('/api/business-tasks/:id/cancel', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.cancelTask(request.principal, params.id, idempotencyKey(request));
  });

  app.get('/api/claims/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.getClaim(request.principal, params.id);
  });

  app.get('/api/evidence/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
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
      audience: raw.audience,
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
  app.get('/api/business-exceptions', notOpen);
  app.all('/api/runtime/:kind', notOpen);

  app.addHook('onClose', async () => repository.close());
  return { app, repository, artifactRepository, artifactService, chatRepository };
}

export { ControlPlaneRepository } from './repository.js';
export { ArtifactRepository } from './artifact-repository.js';
export { ArtifactService } from './artifact-service.js';
export { ChatRepository } from './chat-repository.js';
export { createWorkerCommandApp, WorkerCommandService } from './worker-command-server.js';
