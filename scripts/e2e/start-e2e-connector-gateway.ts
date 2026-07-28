import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { type Readable } from 'node:stream';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredPort(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} is invalid`);
  return value;
}

const runId = required('GENEWAY_RUN_ID');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');

const gatewayPort = requiredPort('GENEWAY_CONNECTOR_GATEWAY_PORT');
const supervisorPort = requiredPort('GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_PORT');
if (gatewayPort === supervisorPort) throw new Error('Connector Gateway supervisor ports must be distinct');

const runDirectory = `/tmp/geneway-runs/${runId}`;
const receiptDirectory = `${runDirectory}/process-boundaries`;
const currentReceiptPath = `${receiptDirectory}/connector-gateway.json`;
const supervisorLogPath = `${receiptDirectory}/connector-gateway-supervisor.jsonl`;
const supervisorTokenFile = required('GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_TOKEN_FILE');

type ProcessIdentity = Readonly<{ pid: number; procStartTicks: string; generation: number }>;
type KillRequest = Readonly<{ pid: number; procStartTicks: string; generation: number; restart?: boolean }>;
type SupervisorEvent =
  | Readonly<{ event: 'connector_gateway.spawned' | 'connector_gateway.ready'; identity: ProcessIdentity }>
  | Readonly<{
    event: 'connector_gateway.kill_requested'; identity: ProcessIdentity; signal: 'SIGKILL'; restart: boolean;
  }>
  | Readonly<{
    event: 'connector_gateway.planned_exit' | 'connector_gateway.paused_exit' | 'connector_gateway.unexpected_exit';
    identity: ProcessIdentity; code: number | null; signal: NodeJS.Signals | null;
  }>
  | Readonly<{ event: 'connector_gateway.resume_requested'; nextGeneration: number }>
  | Readonly<{ event: 'connector_gateway.identity_error' | 'connector_gateway.spawn_error'; generation: number }>
  | Readonly<{ event: 'connector_gateway.supervisor_stopping'; signal: NodeJS.Signals }>;

let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let identity: ProcessIdentity | undefined;
let generation = 0;
let ready = false;
let paused = false;
let restartRequested = false;
let stopping = false;
let controlInProgress = false;
let restartTimer: NodeJS.Timeout | undefined;
let recordTail: Promise<void> = Promise.resolve();

async function readSupervisorToken(filePath: string): Promise<string> {
  if (!isAbsolute(filePath)) throw new Error('Connector Gateway supervisor token path must be absolute');
  const parentPath = dirname(filePath);
  const [resolvedFile, resolvedParent, parentStat, pathStat] = await Promise.all([
    realpath(filePath),
    realpath(parentPath),
    lstat(parentPath),
    lstat(filePath),
  ]);
  if (dirname(resolvedParent) !== '/tmp' || !/^gw-a3-[A-Za-z0-9._-]+$/u.test(basename(resolvedParent))
    || resolvedFile !== resolve(filePath) || resolvedParent !== resolve(parentPath)
    || !parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid?.()
    || (parentStat.mode & 0o777) !== 0o700
    || !pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.uid !== process.getuid?.()
    || (pathStat.mode & 0o777) !== 0o600 || pathStat.size < 32 || pathStat.size > 4_096) {
    throw new Error('Connector Gateway supervisor token must be an owned regular 0600 run file');
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino
      || openedStat.uid !== pathStat.uid || (openedStat.mode & 0o777) !== 0o600
      || openedStat.size !== pathStat.size) {
      throw new Error('Connector Gateway supervisor token identity changed while opening');
    }
    const token = (await handle.readFile('utf8')).trim();
    if (token.length < 32 || token.length > 4_096 || /\s/u.test(token)) {
      throw new Error('Connector Gateway supervisor token is malformed');
    }
    return token;
  } finally {
    await handle.close();
  }
}

const supervisorToken = await readSupervisorToken(supervisorTokenFile);

async function readProcStartTicks(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
  const closingParenthesis = raw.lastIndexOf(')');
  const ticks = closingParenthesis < 1 ? undefined : raw.slice(closingParenthesis + 1).trim().split(/\s+/u)[19];
  if (ticks === undefined || !/^\d+$/u.test(ticks)) throw new Error('Connector Gateway process identity is invalid');
  return ticks;
}

async function identityIsLive(current: ProcessIdentity): Promise<boolean> {
  try {
    return await readProcStartTicks(current.pid) === current.procStartTicks;
  } catch {
    return false;
  }
}

function record(event: SupervisorEvent): Promise<void> {
  const encoded = `${JSON.stringify({
    schemaVersion: 'geneway-e2e-connector-gateway-supervisor-event/1',
    runId,
    recordedAt: new Date().toISOString(),
    ...event,
  })}\n`;
  recordTail = recordTail.catch(() => undefined).then(async () => {
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    await chmod(receiptDirectory, 0o700);
    await appendFile(supervisorLogPath, encoded, { mode: 0o600 });
    await chmod(supervisorLogPath, 0o600);
  });
  return recordTail;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function persistReadyReceipt(current: ProcessIdentity): Promise<void> {
  const receipt = `${JSON.stringify({
    schemaVersion: 'geneway-process-boundary/1',
    role: 'connector-gateway',
    phase: 'ready',
    ready: true,
    checked: true,
    ...current,
    supervisorPid: process.pid,
    forbiddenNamesPresent: [],
  })}\n`;
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await atomicWrite(`${receiptDirectory}/connector-gateway-generation-${String(current.generation)}.json`, receipt);
  await atomicWrite(currentReceiptPath, receipt);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_TOKEN_FILE;
  delete environment.GENEWAY_CONNECTOR_GATEWAY_SUPERVISOR_PORT;
  return environment;
}

function scheduleRestart(): void {
  if (stopping || paused) return;
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    startGateway();
  }, 25);
}

function startGateway(): void {
  if (stopping || paused || child !== undefined) return;
  generation += 1;
  const currentGeneration = generation;
  ready = false;
  identity = undefined;
  const next = spawn(process.execPath, ['--import', 'tsx', 'services/connector-gateway/src/main.ts'], {
    cwd: process.cwd(),
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = next;
  next.stdout.pipe(process.stdout);
  next.stderr.pipe(process.stderr);

  void (async () => {
    if (next.pid === undefined) throw new Error('Connector Gateway child did not expose a PID');
    const nextIdentity = {
      pid: next.pid,
      procStartTicks: await readProcStartTicks(next.pid),
      generation: currentGeneration,
    } as const;
    if (child !== next || stopping) return;
    identity = nextIdentity;
    await record({ event: 'connector_gateway.spawned', identity: nextIdentity });
  })().catch(() => {
    void record({ event: 'connector_gateway.identity_error', generation: currentGeneration });
  });

  next.once('error', () => {
    void record({ event: 'connector_gateway.spawn_error', generation: currentGeneration });
  });
  next.once('exit', (code, signal) => {
    const exitedIdentity = identity?.generation === currentGeneration
      ? identity
      : { pid: next.pid ?? -1, procStartTicks: 'unavailable', generation: currentGeneration };
    if (child === next) {
      child = undefined;
      identity = undefined;
      ready = false;
    }
    if (stopping) return;
    if (restartRequested) {
      restartRequested = false;
      void record({ event: 'connector_gateway.planned_exit', identity: exitedIdentity, code, signal })
        .finally(scheduleRestart);
      return;
    }
    if (paused) {
      void record({ event: 'connector_gateway.paused_exit', identity: exitedIdentity, code, signal });
      return;
    }
    void record({ event: 'connector_gateway.unexpected_exit', identity: exitedIdentity, code, signal });
  });
}

async function probeGateway(): Promise<boolean> {
  const current = identity;
  const currentChild = child;
  if (paused || current === undefined || currentChild?.pid !== current.pid || !await identityIsLive(current)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok || identity !== current || child !== currentChild || !await identityIsLive(current)) return false;
    if (!ready) {
      await persistReadyReceipt(current);
      if (identity !== current || child !== currentChild || !await identityIsLive(current)) return false;
      ready = true;
      await record({ event: 'connector_gateway.ready', identity: current });
    }
    return ready;
  } catch {
    return false;
  }
}

function bearerMatches(header: string | undefined): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(supervisorToken, 'utf8');
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  }).end(JSON.stringify(body));
}

function authenticate(request: IncomingMessage, response: ServerResponse): boolean {
  if (bearerMatches(request.headers.authorization)) return true;
  sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
  return false;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.byteLength;
    if (length > 64 * 1024) throw new Error('body_invalid');
    chunks.push(bytes);
  }
  if (length === 0) throw new Error('body_invalid');
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body_invalid');
  return parsed as Record<string, unknown>;
}

function validKillRequest(body: Record<string, unknown>): body is KillRequest {
  return Number.isSafeInteger(body.pid) && Number(body.pid) > 0
    && typeof body.procStartTicks === 'string' && /^\d+$/u.test(body.procStartTicks)
    && Number.isSafeInteger(body.generation) && Number(body.generation) > 0
    && (body.restart === undefined || typeof body.restart === 'boolean');
}

async function handleKill(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authenticate(request, response)) return;
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  if (!validKillRequest(body)) {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  if (controlInProgress) {
    sendJson(response, 409, { error: 'E2E_CONNECTOR_GATEWAY_CONTROL_BUSY' });
    return;
  }
  controlInProgress = true;
  try {
    const current = identity;
    const currentChild = child;
    if (!ready || current === undefined || currentChild?.pid !== current.pid
      || body.pid !== current.pid || body.procStartTicks !== current.procStartTicks
      || body.generation !== current.generation || !await identityIsLive(current)) {
      sendJson(response, 409, { error: 'E2E_CONNECTOR_GATEWAY_IDENTITY_STALE' });
      return;
    }
    const shouldRestart = body.restart !== false;
    restartRequested = shouldRestart;
    paused = !shouldRestart;
    ready = false;
    if (!currentChild.kill('SIGKILL')) {
      restartRequested = false;
      paused = false;
      sendJson(response, 409, { error: 'E2E_CONNECTOR_GATEWAY_KILL_FAILED' });
      return;
    }
    await record({
      event: 'connector_gateway.kill_requested',
      identity: current,
      signal: 'SIGKILL',
      restart: shouldRestart,
    });
    sendJson(response, 202, {
      killed: current,
      restartScheduled: shouldRestart,
      nextGeneration: shouldRestart ? current.generation + 1 : null,
    });
  } finally {
    controlInProgress = false;
  }
}

async function handleResume(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authenticate(request, response)) return;
  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  if (Object.keys(body).length !== 0) {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  if (controlInProgress) {
    sendJson(response, 409, { error: 'E2E_CONNECTOR_GATEWAY_CONTROL_BUSY' });
    return;
  }
  if (!paused || ready || child !== undefined) {
    sendJson(response, 409, { error: 'E2E_CONNECTOR_GATEWAY_NOT_PAUSED' });
    return;
  }
  paused = false;
  const nextGeneration = generation + 1;
  await record({ event: 'connector_gateway.resume_requested', nextGeneration });
  startGateway();
  sendJson(response, 202, { restartScheduled: true, nextGeneration: generation });
}

function handleError(response: ServerResponse): void {
  if (!response.headersSent) sendJson(response, 500, { error: 'E2E_SUPERVISOR_INTERNAL_ERROR' });
  else response.destroy();
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    if (!authenticate(request, response)) return;
    void probeGateway().then((serviceReady) => sendJson(response, serviceReady ? 200 : 503, {
      ready: serviceReady,
      generation,
      pid: identity?.pid ?? null,
      procStartTicks: identity?.procStartTicks ?? null,
    })).catch(() => handleError(response));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/kill-connector-gateway') {
    void handleKill(request, response).catch(() => handleError(response));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/resume-connector-gateway') {
    void handleResume(request, response).catch(() => handleError(response));
    return;
  }
  response.writeHead(404).end();
});

await new Promise<void>((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(supervisorPort, '127.0.0.1', resolveListen);
});
startGateway();

async function closeServer(currentServer: Server): Promise<void> {
  if (!currentServer.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    currentServer.close((error) => error === undefined ? resolveClose() : reject(error));
  });
}

async function stopChild(signal: NodeJS.Signals): Promise<void> {
  const currentChild = child;
  const currentIdentity = identity;
  if (currentChild === undefined || currentChild.exitCode !== null || currentChild.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => currentChild.once('exit', () => resolveExit()));
  currentChild.kill(signal);
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_000)),
  ]);
  if (!graceful) {
    if (currentIdentity === undefined || await identityIsLive(currentIdentity)) currentChild.kill('SIGKILL');
    await exited;
  }
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  restartRequested = false;
  paused = false;
  if (restartTimer !== undefined) clearTimeout(restartTimer);
  await record({ event: 'connector_gateway.supervisor_stopping', signal }).catch(() => undefined);
  await Promise.all([closeServer(server), stopChild(signal)]);
  await recordTail.catch(() => undefined);
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });
