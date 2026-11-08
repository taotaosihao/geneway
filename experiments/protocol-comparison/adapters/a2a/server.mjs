import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentEvent, DefaultRequestHandler, JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server';
import { createComparisonDomain } from '../../common/domain.mjs';
import { fixture, digest } from '../../common/fixture.mjs';

function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
export async function startA2aAdapter({ root, port = 0, host = '127.0.0.1', credentials, tls, echoActor = 'peer-a2a' }) {
  await mkdir(root, { recursive: true });
  const domain = await createComparisonDomain({ root: path.join(root, 'domain') });
  const principals = new Map(Object.entries(credentials));
  const actorFor = request => { const token = request.headers.authorization?.replace(/^Bearer /, ''); return [...principals].find(([, value]) => value === token)?.[0]; };
  const wireFile = path.join(root, 'wire.jsonl');
  let origin, card, handler, transport;
  const taskStore = {
    async load(id, context) { try { return await domain.task(context.user.userName, id); } catch (error) { if (['NOT_FOUND','FORBIDDEN'].includes(error.code)) return undefined; throw error; } },
    async save(task, context) {
      const current = await domain.task(context.user.userName, task.id);
      // ResultManager may retain protocol history; it cannot change Work state.
      if (task.status?.state !== current.status.state || task.contextId !== current.contextId) throw Object.assign(Error('Unproven Task transition'), { code: 'INVALID_STATE' });
    },
    async list(parameters, context) {
      const tasks = []; for (const attempt of (await domain.store.read()).multisite.attempts) { const task = await this.load(attempt.attempt_id, context); if (task) tasks.push(task); }
      return { tasks, totalSize: tasks.length, pageSize: tasks.length, nextPageToken: '' };
    },
  };
  const executor = {
    async execute(context, bus) {
      const message = context.userMessage, actor = context.context.user.userName;
      const text = message.parts.find(part => part.content?.$case === 'text')?.content.value;
      const data = message.parts.find(part => part.content?.$case === 'data')?.content.value;
      let reply;
      if (actor === echoActor && text !== undefined) reply = { echo: text, protocol: 'a2a', wireVersion: '1.0', receiver: 'geneway-comparison' };
      else { if (actor === echoActor) throw Object.assign(Error('FORBIDDEN'), { code: 'FORBIDDEN' }); reply = await domain.dispatch(actor, data ?? JSON.parse(text)); }
      bus.publish(AgentEvent.message({ messageId: `reply-${message.messageId}`, role: 2, contextId: message.contextId || context.contextId, taskId: '', parts: [{ content: { $case: 'data', value: reply }, mediaType: 'application/json', filename: '' }], extensions: [], referenceTaskIds: [] }));
      bus.finished();
    },
    async cancelTask() { throw Object.assign(Error('Cancellation must use the current domain command and verified stop'), { code: 'INVALID_STATE' }); },
  };
  const listener = async (request, response) => {
    const startedAt = new Date().toISOString(); let body = '', result;
    try {
      const actor = actorFor(request), url = new URL(request.url, origin);
      if (url.pathname === '/.well-known/agent-card.json' && request.method === 'GET') return json(response, 200, card);
      if (!actor) return json(response, 401, { error: { code: 'UNAUTHORIZED' } });
      if (request.method === 'GET' && url.pathname === '/discovery') return json(response, 200, { agents: fixture.agents, applicationAuthorization: 'current Geneway owner, agent and execution binding', protocolRoleIsHumanAuthorization: false });
      if (request.method !== 'POST' || url.pathname !== '/a2a') return json(response, 404, { error: { code: 'NOT_FOUND' } });
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 262144) throw Object.assign(Error('Request too large'), { code: 'TOO_LARGE' }); }
      const rpc = JSON.parse(body), version = request.headers['a2a-version'] ?? '0.3';
      try { validateVersion(version, card, 'JSONRPC'); } catch (error) { return json(response, 400, { jsonrpc: '2.0', id: rpc.id ?? null, error: JsonRpcTransportHandler.mapToJSONRPCError(error) }); }
      const context = new ServerCallContext({ requestedVersion: version, user: { isAuthenticated: true, userName: actor }, state: new Map([['headers', request.headers]]) });
      if (rpc.method === 'CancelTask') {
        const task = await domain.task(actor, rpc.params.id);
        if (actor !== 'owner') throw Object.assign(Error('FORBIDDEN'), { code: 'FORBIDDEN' });
        await domain.dispatch(actor, { operation: 'cancel', parameters: { workId: task.contextId, clientRequestId: `a2a-cancel-${task.id}` } });
        await domain.drain();
      }
      result = await transport.handle(rpc, context);
      if (result?.[Symbol.asyncIterator]) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for await (const event of result) { const line = JSON.stringify(event); response.write(`data: ${line}\n\n`); await appendFile(wireFile, JSON.stringify({ at: new Date().toISOString(), direction: 'out', protocol: 'a2a', version, actor, requestId: rpc.id, frame: event, bytes: Buffer.byteLength(line) }) + '\n'); }
        response.end();
      } else json(response, 200, result);
      await appendFile(wireFile, JSON.stringify({ at: startedAt, direction: 'exchange', protocol: 'a2a', version, actor, request: rpc, response: result?.[Symbol.asyncIterator] ? 'stream' : result, requestBytes: Buffer.byteLength(body), responseBytes: result?.[Symbol.asyncIterator] ? null : Buffer.byteLength(JSON.stringify(result)) }) + '\n');
    } catch (error) { if (!response.headersSent) json(response, error.code === 'FORBIDDEN' ? 403 : 400, { error: { code: error.code ?? 'INVALID_REQUEST', message: error.message } }); else response.destroy(); }
  };
  const server = tls ? createHttpsServer({ key: await readFile(tls.keyFile), cert: await readFile(tls.certFile) }, listener) : createHttpServer(listener);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  origin = `${tls ? 'https' : 'http'}://${host}:${server.address().port}`;
  card = { name: 'Geneway isolated protocol comparison', description: 'Experimental wire over the existing Geneway domain. No production endpoint.', version: '1.0.0', supportedInterfaces: [{ url: origin + '/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }], capabilities: { streaming: true, pushNotifications: false }, securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'opaque experiment credential' } } }, securityRequirements: [{ schemes: { bearer: [] } }], defaultInputModes: ['application/json','text/plain'], defaultOutputModes: ['application/json'], skills: fixture.agents.map(agent => ({ id: agent.id, name: agent.id, description: agent.capabilities.join(','), tags: agent.capabilities, examples: [], inputModes: ['application/json'], outputModes: ['application/json'] })), signatures: [] };
  handler = new DefaultRequestHandler(card, taskStore, executor); transport = new JsonRpcTransportHandler(handler);
  await writeFile(path.join(root, 'agent-card.json'), JSON.stringify(card, null, 2));
  return { origin, card, domain, async close() { await domain.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[process.argv.indexOf('--config') + 1], config = JSON.parse(await readFile(configPath));
  const adapter = await startA2aAdapter(config); console.log(JSON.stringify({ event: 'ready', origin: adapter.origin, pid: process.pid, protocol: 'a2a', versions: { sdk: '1.3.0', wire: '1.0' } }));
  let closing = false; const close = async () => { if (closing) return; closing = true; await adapter.close(); process.exitCode = 0; };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
