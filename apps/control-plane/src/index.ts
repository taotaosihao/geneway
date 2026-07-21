import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deriveTrustedLocalPrincipal } from '@geneway/authorization';
import { createTaskInputSchema, GenewayError, isGenewayError, type Principal } from '@geneway/contracts';
import {
  MAX_MULTIPART_ENVELOPE_BYTES,
  MAX_RAW_UPLOAD_BYTES,
  parseSingleMultipartUpload,
  validateTextUpload,
  type SingleMultipartUpload,
} from '@geneway/ingestion';
import { createObjectStorageFromEnv, type ObjectStorage } from '@geneway/storage';
import { WorkflowInterpreter } from '@geneway/worker';
import { FIXTURE_CONTENT_HASH, FIXTURE_EXCERPT, FIXTURE_REF, FIXTURE_VERSION } from '@geneway/evidence';
import { ControlPlaneRepository } from './repository.js';
import { ArtifactRepository } from './artifact-repository.js';
import { ArtifactService } from './artifact-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : '';
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
}>;

export async function createControlPlane(options: Readonly<{
  databaseUrl: string;
  logger?: boolean;
  allowedOrigins?: readonly string[];
  objectStorage?: ObjectStorage | null;
  principalResolver?: PrincipalResolver;
}>): Promise<ControlPlane> {
  const repository = new ControlPlaneRepository(options.databaseUrl);
  const artifactRepository = new ArtifactRepository(repository.pool);
  const objectStorage = options.objectStorage === undefined ? createObjectStorageFromEnv() : options.objectStorage;
  const artifactService = objectStorage === null ? null : new ArtifactService(artifactRepository, objectStorage);
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
    return repository.getConversation(request.principal, params.id);
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

  app.get('/api/capabilities', () => ([{
    id: 'solution.analysis.v1', version: 1, name: '方案分析', fixtureOnly: true,
    simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false,
  }]));

  app.get('/api/capabilities/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
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

  app.get('/api/business-tasks/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.getTask(request.principal, params.id);
  });

  app.get('/api/business-tasks/:id/events', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ afterCursor: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    const events = await repository.getEvents(request.principal, params.id, query.afterCursor);
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
    return { events };
  });

  app.get('/api/workflow-versions/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const workflow = await repository.getWorkflow(request.principal, params.id);
    return { id: workflow.id, hash: workflow.hash, canonicalizationVersion: workflow.canonicalizationVersion, payload: workflow.payload };
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
    return repository.executeIdempotently(request.principal, params.id, idempotencyKey(request), async () => {
      const task = await repository.getTask(request.principal, params.id);
      const workflow = await repository.getWorkflow(request.principal, task.workflowVersion.id);
      await repository.startTask(request.principal.tenantId, params.id, workflow);
      void new WorkflowInterpreter(repository, undefined, 30).execute({
        tenantId: request.principal.tenantId,
        taskId: params.id,
        fixtureRef: 'fixture:solution-analysis:v1',
        workflow,
        alreadyStarted: true,
      }).catch((error: unknown) => app.log.error(error));
      return { taskId: params.id, status: 'accepted' };
    });
  });

  app.get('/api/claims/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.getClaim(request.principal, params.id);
  });

  app.get('/api/evidence/:id', async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return repository.getEvidence(request.principal, params.id);
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
  return { app, repository, artifactRepository, artifactService };
}

export { ControlPlaneRepository } from './repository.js';
export { ArtifactRepository } from './artifact-repository.js';
export { ArtifactService } from './artifact-service.js';
