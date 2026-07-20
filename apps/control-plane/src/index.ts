import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertTrustedOrigin, deriveTrustedLocalPrincipal } from '@geneway/authorization';
import { createTaskInputSchema, isGenewayError, type Principal } from '@geneway/contracts';
import { WorkflowInterpreter } from '@geneway/worker';
import { ControlPlaneRepository } from './repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : '';
};

const requireMutationOrigin = (request: FastifyRequest): void => {
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    assertTrustedOrigin(request.headers.origin);
  }
};

export type ControlPlane = Readonly<{ app: FastifyInstance; repository: ControlPlaneRepository }>;

export async function createControlPlane(options: Readonly<{ databaseUrl: string; logger?: boolean }>): Promise<ControlPlane> {
  const repository = new ControlPlaneRepository(options.databaseUrl);
  await repository.ensureSystemSeed();
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false, bodyLimit: 64 * 1024 });
  app.decorateRequest('principal', {
    getter(this: FastifyRequest) {
      return deriveTrustedLocalPrincipal(this.ip);
    },
  });
  await app.register(cors, {
    origin: ['http://localhost:3200', 'http://127.0.0.1:3200'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'idempotency-key'],
  });

  app.addHook('onRequest', (request, _reply, done) => {
    void request.principal;
    requireMutationOrigin(request);
    done();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (isGenewayError(error)) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ error: { code: 'INVALID_INPUT', message: 'Request does not match the contract', issues: error.issues } });
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

  app.get('/api/capabilities', () => ([{
    id: 'solution.analysis.v1', version: 1, name: '方案分析', fixtureOnly: true,
    simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false,
  }]));

  app.get('/api/capabilities/:id', async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    if (params.id !== 'solution.analysis.v1') return reply.status(404).send({ error: { code: 'CAPABILITY_NOT_FOUND' } });
    return { id: params.id, version: 1, workflowNodeCount: 7, fixtureRef: 'fixture:solution-analysis:v1', simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false };
  });

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
      await new WorkflowInterpreter(repository).execute({
        tenantId: request.principal.tenantId,
        taskId: params.id,
        fixtureRef: 'fixture:solution-analysis:v1',
        workflow,
      });
      return { taskId: params.id, status: 'completed' };
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

  const notOpen = async (_request: FastifyRequest, reply: FastifyReply) => reply.status(422).send({ error: { code: 'NOT_OPEN', message: 'This capability is not open in Gate 0.1' } });
  app.post('/api/uploads', notOpen);
  app.get('/api/artifacts/:id/download', notOpen);
  app.get('/api/business-exceptions', notOpen);
  app.all('/api/runtime/:kind', notOpen);

  app.addHook('onClose', async () => repository.close());
  return { app, repository };
}

export { ControlPlaneRepository } from './repository.js';
