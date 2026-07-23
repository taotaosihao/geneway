import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { type Readable } from 'node:stream';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const runId = required('GENEWAY_RUN_ID');
const gatewayPort = Number(required('GENEWAY_MODEL_GATEWAY_PORT'));
const supervisorPort = Number(required('GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT'));
const tokenFile = required('GENEWAY_WORKER_TOKEN_FILE');
if (![gatewayPort, supervisorPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65_535)
  || gatewayPort === supervisorPort) throw new Error('Model Gateway supervisor ports are invalid');

const receiptDirectory = `/tmp/geneway-runs/${runId}/process-boundaries`;
const receiptPath = `${receiptDirectory}/model-gateway.json`;
const supervisorLogPath = `${receiptDirectory}/model-gateway-supervisor.jsonl`;
type Identity = Readonly<{ pid: number; procStartTicks: string; generation: number }>;

let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let identity: Identity | undefined;
let generation = 0;
let ready = false;
let paused = false;
let restartRequested = false;
let stopping = false;
let unexpectedExit = false;

async function procStartTicks(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
  const closingParenthesis = raw.lastIndexOf(')');
  const ticks = closingParenthesis < 1 ? undefined : raw.slice(closingParenthesis + 1).trim().split(/\s+/u)[19];
  if (ticks === undefined || !/^\d+$/u.test(ticks)) throw new Error('Model Gateway process identity is invalid');
  return ticks;
}

async function record(event: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await appendFile(supervisorLogPath, `${JSON.stringify({
    schemaVersion: 'geneway-e2e-model-gateway-supervisor-event/1', runId,
    recordedAt: new Date().toISOString(), generation, ...event,
  })}\n`, { mode: 0o600 });
}

async function persistReady(current: Identity): Promise<void> {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await writeFile(receiptPath, `${JSON.stringify({
    schemaVersion: 'geneway-process-boundary/1', role: 'model-gateway', phase: 'ready', ready: true,
    checked: true, ...current, supervisorPid: process.pid, forbiddenNamesPresent: [],
  })}\n`, { mode: 0o600 });
}

function startGateway(): void {
  if (stopping || paused) return;
  generation += 1;
  ready = false;
  identity = undefined;
  const next = spawn(process.execPath, ['--import', 'tsx', 'services/model-gateway/src/main.ts'], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = next;
  next.stdout.pipe(process.stdout);
  next.stderr.pipe(process.stderr);
  void (async () => {
    if (next.pid === undefined) throw new Error('Model Gateway child did not expose a PID');
    identity = { pid: next.pid, procStartTicks: await procStartTicks(next.pid), generation };
    await record({ event: 'model_gateway.spawned', ...identity });
  })().catch((error: unknown) => {
    unexpectedExit = true;
    process.stderr.write(`Unable to record Model Gateway identity: ${String(error)}\n`);
  });
  next.once('error', (error) => {
    unexpectedExit = true;
    process.stderr.write(`${error.stack ?? error.message}\n`);
  });
  next.once('exit', (code, signal) => {
    ready = false;
    if (stopping) return;
    if (restartRequested) {
      restartRequested = false;
      void record({ event: 'model_gateway.planned_exit', code, signal }).finally(() => setTimeout(startGateway, 25));
      return;
    }
    if (paused) {
      void record({ event: 'model_gateway.paused_exit', code, signal });
      return;
    }
    unexpectedExit = true;
    process.stderr.write(`Model Gateway exited unexpectedly: code=${String(code)} signal=${String(signal)}\n`);
    void record({ event: 'model_gateway.unexpected_exit', code, signal });
  });
}

async function probe(): Promise<boolean> {
  const current = identity;
  if (paused || child?.pid === undefined || current === undefined || child.pid !== current.pid) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok || await procStartTicks(current.pid) !== current.procStartTicks) return false;
    if (!ready) {
      ready = true;
      await persistReady(current);
      await record({ event: 'model_gateway.ready', ...current });
    }
    return true;
  } catch {
    return false;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error('Model Gateway supervisor body is invalid');
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Model Gateway supervisor body is invalid');
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function authenticated(request: IncomingMessage): Promise<boolean> {
  return request.headers.authorization === `Bearer ${(await readFile(tokenFile, 'utf8')).trim()}`;
}

async function killGateway(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!await authenticated(request)) return sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
  const body = await readJson(request);
  const current = identity;
  if (!ready || current === undefined || child?.pid !== current.pid
    || body.pid !== current.pid || body.procStartTicks !== current.procStartTicks || body.generation !== current.generation
    || (body.restart !== undefined && typeof body.restart !== 'boolean')) {
    return sendJson(response, 409, { error: 'E2E_MODEL_GATEWAY_IDENTITY_STALE' });
  }
  const restart = body.restart !== false;
  restartRequested = restart;
  paused = !restart;
  ready = false;
  if (!child.kill('SIGKILL')) {
    restartRequested = false;
    paused = false;
    return sendJson(response, 409, { error: 'E2E_MODEL_GATEWAY_KILL_FAILED' });
  }
  await record({ event: 'model_gateway.kill_requested', ...current, restart });
  sendJson(response, 202, { killed: current, restartScheduled: restart, nextGeneration: restart ? generation + 1 : null });
}

async function resumeGateway(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!await authenticated(request)) return sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
  if (!paused || ready || (child !== undefined && child.exitCode === null && child.signalCode === null)) {
    return sendJson(response, 409, { error: 'E2E_MODEL_GATEWAY_NOT_PAUSED' });
  }
  paused = false;
  await record({ event: 'model_gateway.resume_requested', nextGeneration: generation + 1 });
  startGateway();
  sendJson(response, 202, { restartScheduled: true, nextGeneration: generation });
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    void probe().then((available) => sendJson(response, available ? 200 : 503, {
      ready: available, generation, pid: identity?.pid ?? null, procStartTicks: identity?.procStartTicks ?? null,
    }));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/kill-model-gateway') {
    void killGateway(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/resume-model-gateway') {
    void resumeGateway(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(supervisorPort, '127.0.0.1', resolve);
});
startGateway();

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  restartRequested = false;
  paused = false;
  const processToStop = child;
  if (processToStop?.exitCode === null && processToStop.signalCode === null) {
    processToStop.kill(signal);
    setTimeout(() => {
      if (processToStop.exitCode === null && processToStop.signalCode === null) processToStop.kill('SIGKILL');
    }, 1_000).unref();
  }
  void new Promise<void>((resolve) => server.close(() => resolve()));
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('beforeExit', () => { if (unexpectedExit) process.exitCode = 1; });
