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
const supervisorPort = Number(required('GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT'));
const servicePort = Number(required('PORT'));
const tokenFile = required('GENEWAY_WORKER_TOKEN_FILE');
if (!Number.isInteger(supervisorPort) || supervisorPort < 1 || supervisorPort > 65_535
  || !Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65_535
  || supervisorPort === servicePort) throw new Error('Control Plane supervisor ports are invalid');

const receiptDirectory = `/tmp/geneway-runs/${runId}/process-boundaries`;
const receiptPath = `${receiptDirectory}/control-plane.json`;
const supervisorLogPath = `${receiptDirectory}/control-plane-supervisor.jsonl`;

type ProcessIdentity = Readonly<{ pid: number; procStartTicks: string; generation: number }>;
type KillRequest = Readonly<{ pid?: number; procStartTicks?: string; generation?: number }>;

let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let identity: ProcessIdentity | undefined;
let generation = 0;
let ready = false;
let restartRequested = false;
let stopping = false;
let unexpectedExit = false;

async function readProcStartTicks(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
  const closingParenthesis = raw.lastIndexOf(')');
  const ticks = closingParenthesis < 1 ? undefined : raw.slice(closingParenthesis + 1).trim().split(/\s+/u)[19];
  if (ticks === undefined || !/^\d+$/u.test(ticks)) throw new Error('Control Plane process identity is invalid');
  return ticks;
}

async function record(event: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await appendFile(supervisorLogPath, `${JSON.stringify({
    schemaVersion: 'geneway-e2e-control-plane-supervisor-event/1',
    runId,
    recordedAt: new Date().toISOString(),
    generation,
    ...event,
  })}\n`, { mode: 0o600 });
}

async function persistReadyReceipt(current: ProcessIdentity): Promise<void> {
  const receipt = {
    schemaVersion: 'geneway-process-boundary/1',
    role: 'control-plane',
    phase: 'ready',
    ready: true,
    checked: true,
    pid: current.pid,
    procStartTicks: current.procStartTicks,
    generation: current.generation,
    supervisorPid: process.pid,
    forbiddenNamesPresent: [],
  } as const;
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await Promise.all([
    writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 }),
    writeFile(`${receiptDirectory}/control-plane-generation-${String(current.generation)}.json`, `${JSON.stringify(receipt)}\n`, { mode: 0o600 }),
  ]);
}

async function probeService(): Promise<boolean> {
  if (child?.pid === undefined || identity === undefined || child.pid !== identity.pid) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${String(servicePort)}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const observedTicks = await readProcStartTicks(identity.pid);
    if (observedTicks !== identity.procStartTicks) return false;
    if (!ready) {
      ready = true;
      await persistReadyReceipt(identity);
      await record({ event: 'control_plane.ready', ...identity });
    }
    return true;
  } catch {
    return false;
  }
}

function startControlPlane(): void {
  if (stopping) return;
  generation += 1;
  ready = false;
  identity = undefined;
  const nextChild = spawn(process.execPath, ['--import', 'tsx', 'apps/control-plane/src/main.ts'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = nextChild;
  nextChild.stdout.pipe(process.stdout);
  nextChild.stderr.pipe(process.stderr);
  void (async () => {
    if (nextChild.pid === undefined) throw new Error('Control Plane child did not expose a PID');
    identity = { pid: nextChild.pid, procStartTicks: await readProcStartTicks(nextChild.pid), generation };
    await record({ event: 'control_plane.spawned', ...identity });
  })().catch((error: unknown) => {
    unexpectedExit = true;
    process.stderr.write(`Unable to record Control Plane identity: ${String(error)}\n`);
    void closeServer().then(() => { process.exitCode = 1; });
  });
  nextChild.stderr.setEncoding('utf8');
  nextChild.stderr.on('data', (chunk: string) => {
    void record({ event: 'control_plane.stderr', pid: nextChild.pid ?? null, chunk });
  });
  nextChild.once('error', (error) => {
    unexpectedExit = true;
    void record({ event: 'control_plane.spawn_error', error: error.stack ?? error.message })
      .finally(() => closeServer().then(() => { process.exitCode = 1; }));
  });
  nextChild.once('exit', (code, signal) => {
    ready = false;
    if (stopping) return;
    if (restartRequested) {
      restartRequested = false;
      void record({ event: 'control_plane.restart_requested_exit', pid: nextChild.pid ?? null, code, signal })
        .finally(() => setTimeout(startControlPlane, 25));
      return;
    }
    unexpectedExit = true;
    process.stderr.write(`E2E Control Plane exited unexpectedly: code=${String(code)} signal=${String(signal)}\n`);
    void record({ event: 'control_plane.unexpected_exit', pid: nextChild.pid ?? null, code, signal })
      .finally(() => closeServer().then(() => { process.exitCode = code ?? 1; }));
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else throw new Error('Control Plane supervisor received an unsupported body chunk');
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function handleKill(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expectedToken = (await readFile(tokenFile, 'utf8')).trim();
  if (request.headers.authorization !== `Bearer ${expectedToken}`) {
    sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
    return;
  }
  const raw = await readBody(request);
  if (raw.byteLength === 0 || raw.byteLength > 64 * 1024) {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  let payload: KillRequest;
  try { payload = JSON.parse(raw.toString('utf8')) as KillRequest; }
  catch {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  const current = identity;
  if (!ready || current === undefined || child?.pid !== current.pid
    || payload.pid !== current.pid || payload.procStartTicks !== current.procStartTicks || payload.generation !== current.generation) {
    sendJson(response, 409, { error: 'E2E_CONTROL_PLANE_IDENTITY_STALE' });
    return;
  }
  restartRequested = true;
  ready = false;
  if (!child.kill('SIGKILL')) {
    restartRequested = false;
    sendJson(response, 409, { error: 'E2E_CONTROL_PLANE_KILL_FAILED' });
    return;
  }
  await record({ event: 'control_plane.kill_requested', ...current, signal: 'SIGKILL' });
  sendJson(response, 202, { killed: current, nextGeneration: current.generation + 1 });
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    void probeService().then((serviceReady) => sendJson(response, serviceReady ? 200 : 503, {
      ready: serviceReady,
      generation,
      pid: identity?.pid ?? null,
      procStartTicks: identity?.procStartTicks ?? null,
    }));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/kill-control-plane') {
    void handleKill(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(supervisorPort, '127.0.0.1', resolve);
});
startControlPlane();

async function closeServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  restartRequested = false;
  if (child?.exitCode === null && child.signalCode === null) child.kill(signal);
  void closeServer();
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('beforeExit', () => {
  if (unexpectedExit) process.exitCode = 1;
});
