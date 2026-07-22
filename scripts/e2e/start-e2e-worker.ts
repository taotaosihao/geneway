import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { type Readable } from 'node:stream';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const runId = required('GENEWAY_RUN_ID');
const healthPort = Number(required('GENEWAY_WORKER_HEALTH_PORT'));
const baseWorkerInstanceId = required('GENEWAY_WORKER_INSTANCE_ID');
const socketPath = required('GENEWAY_WORKER_SOCKET_PATH');
const tokenFile = required('GENEWAY_WORKER_TOKEN_FILE');
const consumer = required('GENEWAY_WORKER_CONSUMER');
const deploymentId = required('GENEWAY_WORKER_DEPLOYMENT');
if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) throw new Error('GENEWAY_WORKER_HEALTH_PORT is invalid');

const receiptDirectory = `/tmp/geneway-runs/${runId}/process-boundaries`;
const receiptPath = `${receiptDirectory}/worker.json`;
const hookReceiptPath = `${receiptDirectory}/e2e-hooks.json`;
const supervisorLogPath = `${receiptDirectory}/worker-supervisor.jsonl`;
const workerEnvironmentBase = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  LANG: process.env.LANG ?? 'C.UTF-8',
  NODE_ENV: 'test',
  GENEWAY_RUN_ID: runId,
  GENEWAY_WORKER_SOCKET_PATH: socketPath,
  GENEWAY_WORKER_TOKEN_FILE: tokenFile,
  GENEWAY_WORKER_CONSUMER: consumer,
  GENEWAY_WORKER_DEPLOYMENT: deploymentId,
  // Keep served-UI progress observable and deterministic without changing
  // production Worker pacing. Recovery hooks still run at the same durable
  // claim/completion boundaries; they only wait briefly between those points.
  GENEWAY_WORKER_STEP_DELAY_MS: process.env.GENEWAY_WORKER_STEP_DELAY_MS ?? '40',
  GENEWAY_E2E_HOOK_URL: `http://127.0.0.1:${String(healthPort)}`,
  GENEWAY_E2E_HOOK_TOKEN_FILE: tokenFile,
};

type WorkerReceipt = Readonly<{
  role?: string;
  phase?: string;
  ready?: boolean;
  pid?: number;
  procStartTicks?: string;
  workerInstanceId?: string;
  forbiddenNamesPresent?: readonly string[];
}>;

type KillRequest = Readonly<{ pid?: number; procStartTicks?: string; workerInstanceId?: string; restart?: boolean }>;
type HookName =
  | 'worker.after_delivery_claim'
  | 'worker.before_complete_step'
  | 'control-plane.after_complete_step_committed_before_response'
  | 'control-plane.after_ingest_intent_put_authority_committed'
  | 'control-plane.after_source_object_put'
  | 'control-plane.after_report_object_verified';
type CommonHookPayload = Readonly<Record<string, unknown> & {
  protocolVersion: 'geneway-e2e-hook/1';
  hook: HookName;
}>;
type WorkerHookPayload = CommonHookPayload & Readonly<{
  taskId: string;
  workerInstanceId: string;
  deliveryId: string;
  eventId: string;
  executionAttemptId: string;
  fencingToken: number;
}>;
type SourceHookPayload = CommonHookPayload & Readonly<{
  conversationId: string;
  idempotencyKey: string;
  ingestIntentId: string;
  artifactId: string;
  documentSnapshotId: string;
  storageKey: string;
}>;
type HookPayload = WorkerHookPayload | SourceHookPayload;
type HookArm = {
  armId: string;
  hook: HookName;
  taskId?: string;
  idempotencyKey?: string;
  stepId?: string;
  state: 'armed' | 'triggered' | 'released' | 'worker_killed' | 'control_plane_killed' | 'error_injected';
  armedAt: string;
  triggeredAt?: string;
  action?: 'continue' | 'worker_sigkill' | 'control_plane_sigkill' | 'inject_error';
  triggerId?: string;
  payload?: HookPayload;
  waitingResponse: ServerResponse | undefined;
};

const hookNames = new Set<HookName>([
  'worker.after_delivery_claim',
  'worker.before_complete_step',
  'control-plane.after_complete_step_committed_before_response',
  'control-plane.after_ingest_intent_put_authority_committed',
  'control-plane.after_source_object_put',
  'control-plane.after_report_object_verified',
]);
const idPattern = /^[a-z][a-z0-9_.:-]{2,255}$/u;

let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let generation = 0;
let activeWorkerInstanceId = '';
let workerReady = false;
let restartRequested = false;
let paused = false;
let stopping = false;
let unexpectedExit = false;
let crashRestarts = 0;
const hookArms = new Map<string, HookArm>();

async function recordWorkerEvent(event: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await appendFile(supervisorLogPath, `${JSON.stringify({
    schemaVersion: 'geneway-e2e-worker-supervisor-event/1',
    runId,
    recordedAt: new Date().toISOString(),
    generation,
    workerInstanceId: activeWorkerInstanceId,
    ...event,
  })}\n`, { mode: 0o600 });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (Buffer.isBuffer(value)) chunks.push(value);
    else if (typeof value === 'string') chunks.push(Buffer.from(value));
    else throw new Error('E2E supervisor received an unsupported body chunk');
  }
  return Buffer.concat(chunks);
}

async function readCurrentReceipt(): Promise<WorkerReceipt> {
  return JSON.parse(await readFile(receiptPath, 'utf8')) as WorkerReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (body.byteLength === 0 || body.byteLength > 64 * 1024) throw new Error('E2E supervisor body is empty or too large');
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (!isRecord(parsed)) throw new Error('E2E supervisor body must be a JSON object');
  return parsed;
}

function authenticated(request: IncomingMessage, expectedToken: string): boolean {
  return request.headers.authorization === `Bearer ${expectedToken}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function hookProjection(arm: HookArm): Readonly<Record<string, unknown>> {
  return {
    armId: arm.armId,
    hook: arm.hook,
    taskId: arm.taskId ?? null,
    idempotencyKey: arm.idempotencyKey ?? null,
    ...(arm.stepId === undefined ? {} : { stepId: arm.stepId }),
    state: arm.state,
    faultTriggered: arm.state !== 'armed',
    released: arm.state === 'released',
    armedAt: arm.armedAt,
    triggeredAt: arm.triggeredAt ?? null,
    action: arm.action ?? null,
    triggerId: arm.triggerId ?? null,
    payload: arm.payload ?? null,
  };
}

async function persistHookReceipt(): Promise<void> {
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  await writeFile(hookReceiptPath, `${JSON.stringify({
    schemaVersion: 'geneway-e2e-hooks/1',
    runId,
    hooks: [...hookArms.values()].map(hookProjection),
  })}\n`, { mode: 0o600 });
}

function parseHookName(value: unknown): HookName | undefined {
  return typeof value === 'string' && hookNames.has(value as HookName) ? value as HookName : undefined;
}

function parseHookPayload(value: Record<string, unknown>): HookPayload | undefined {
  const hook = parseHookName(value.hook);
  if (value.protocolVersion !== 'geneway-e2e-hook/1' || hook === undefined) return undefined;
  if (hook === 'control-plane.after_ingest_intent_put_authority_committed' || hook === 'control-plane.after_source_object_put') {
    if (typeof value.conversationId !== 'string' || !idPattern.test(value.conversationId)
      || typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length < 8 || value.idempotencyKey.length > 200
      || typeof value.ingestIntentId !== 'string' || !idPattern.test(value.ingestIntentId)
      || typeof value.artifactId !== 'string' || !idPattern.test(value.artifactId)
      || typeof value.documentSnapshotId !== 'string' || !idPattern.test(value.documentSnapshotId)
      || typeof value.storageKey !== 'string' || !value.storageKey.startsWith('tenants/')) return undefined;
    if (hook === 'control-plane.after_ingest_intent_put_authority_committed' && (
      value.intentStatus !== 'put_inflight' || !Number.isSafeInteger(value.stateVersion) || Number(value.stateVersion) < 1
    )) return undefined;
    if (hook === 'control-plane.after_source_object_put' && (
      typeof value.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.contentSha256)
      || (value.eTag !== null && typeof value.eTag !== 'string')
      || (value.versionId !== null && typeof value.versionId !== 'string')
    )) return undefined;
    return value as SourceHookPayload;
  }
  if (typeof value.taskId !== 'string' || !idPattern.test(value.taskId)
    || typeof value.workerInstanceId !== 'string' || !/^e2e-worker-[a-zA-Z0-9._-]+$/u.test(value.workerInstanceId)
    || typeof value.deliveryId !== 'string' || !idPattern.test(value.deliveryId)
    || typeof value.eventId !== 'string' || !idPattern.test(value.eventId)
    || typeof value.executionAttemptId !== 'string' || !idPattern.test(value.executionAttemptId)
    || !Number.isSafeInteger(value.fencingToken) || Number(value.fencingToken) < 1) return undefined;
  if ((hook === 'worker.before_complete_step' || hook === 'control-plane.after_complete_step_committed_before_response') && (
    typeof value.stepId !== 'string' || !idPattern.test(value.stepId)
    || typeof value.stepAttemptId !== 'string' || !idPattern.test(value.stepAttemptId)
    || !Number.isSafeInteger(value.stepFencingToken) || Number(value.stepFencingToken) < 1
    || (hook === 'control-plane.after_complete_step_committed_before_response'
      && (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length < 8 || value.idempotencyKey.length > 200))
  )) return undefined;
  if (hook === 'control-plane.after_report_object_verified' && (
    typeof value.reportIntentId !== 'string' || !idPattern.test(value.reportIntentId)
    || typeof value.artifactId !== 'string' || !idPattern.test(value.artifactId)
    || typeof value.storageKey !== 'string' || !value.storageKey.startsWith('tenants/')
    || typeof value.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.contentSha256)
  )) return undefined;
  return value as WorkerHookPayload;
}

async function archiveGenerationReceipt(receipt: WorkerReceipt): Promise<void> {
  if (receipt.pid !== child?.pid || receipt.workerInstanceId !== activeWorkerInstanceId || receipt.phase !== 'ready') return;
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  const enriched = {
    ...receipt,
    generation,
    supervisorPid: process.pid,
  };
  await Promise.all([
    writeFile(receiptPath, `${JSON.stringify(enriched)}\n`, { mode: 0o600 }),
    writeFile(`${receiptDirectory}/worker-generation-${String(generation)}.json`, `${JSON.stringify(enriched)}\n`, { mode: 0o600 }),
  ]);
}

function instanceIdForGeneration(nextGeneration: number): string {
  return nextGeneration === 1 ? baseWorkerInstanceId : `${baseWorkerInstanceId}-g${String(nextGeneration)}`;
}

function startWorker(): void {
  if (stopping || paused) return;
  generation += 1;
  activeWorkerInstanceId = instanceIdForGeneration(generation);
  workerReady = false;
  const nextChild = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], {
    cwd: process.cwd(),
    env: { ...workerEnvironmentBase, GENEWAY_WORKER_INSTANCE_ID: activeWorkerInstanceId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = nextChild;
  void recordWorkerEvent({ event: 'worker.spawned', pid: nextChild.pid ?? null });
  nextChild.stdout.pipe(process.stdout);
  nextChild.stderr.pipe(process.stderr);
  nextChild.stdout.setEncoding('utf8');
  nextChild.stderr.setEncoding('utf8');
  nextChild.stdout.on('data', (chunk: string) => {
    if (!chunk.includes('GENEWAY_WORKER_READY')) return;
    workerReady = true;
    // Count only consecutive failures to reach readiness. Planned Control Plane
    // SIGKILL cases may terminate an already-ready Worker transport, but a later
    // healthy generation must reset the supervisor's crash-loop budget.
    crashRestarts = 0;
    void recordWorkerEvent({ event: 'worker.ready', pid: nextChild.pid ?? null });
    void readCurrentReceipt().then(archiveGenerationReceipt).catch((error: unknown) => {
      process.stderr.write(`Unable to archive Worker generation receipt: ${String(error)}\n`);
    });
  });
  nextChild.stderr.on('data', (chunk: string) => {
    void recordWorkerEvent({ event: 'worker.stderr', pid: nextChild.pid ?? null, chunk });
  });
  nextChild.once('error', (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    unexpectedExit = true;
    void recordWorkerEvent({
      event: 'worker.spawn_error',
      pid: nextChild.pid ?? null,
      error: error.stack ?? error.message,
    }).finally(() => closeServer().then(() => { process.exitCode = 1; }));
  });
  nextChild.once('exit', (code, signal) => {
    workerReady = false;
    if (stopping) return;
    if (restartRequested) {
      restartRequested = false;
      void recordWorkerEvent({
        event: 'worker.restart_requested_exit',
        pid: nextChild.pid ?? null,
        code,
        signal,
      }).finally(() => setTimeout(startWorker, 25));
      return;
    }
    if (paused) {
      void recordWorkerEvent({ event: 'worker.paused_exit', pid: nextChild.pid ?? null, code, signal });
      return;
    }
    crashRestarts += 1;
    process.stderr.write(`E2E Worker exited unexpectedly; supervisor restart ${String(crashRestarts)}: code=${String(code)} signal=${String(signal)}\n`);
    void recordWorkerEvent({
      event: 'worker.crash_restart',
      pid: nextChild.pid ?? null,
      code,
      signal,
      crashRestarts,
    }).finally(() => {
      if (crashRestarts > 5) {
        unexpectedExit = true;
        void closeServer().then(() => { process.exitCode = code ?? 1; });
      } else {
        setTimeout(startWorker, 100);
      }
    });
  });
}

async function isReady(): Promise<boolean> {
  try {
    const tokenStat = await stat(tokenFile);
    const socketStat = await stat(socketPath);
    const receipt = await readCurrentReceipt();
    const ready = workerReady
      && tokenStat.isFile()
      && (tokenStat.mode & 0o777) === 0o600
      && socketStat.isSocket()
      && (socketStat.mode & 0o777) === 0o600
      && receipt.role === 'worker'
      && receipt.phase === 'ready'
      && receipt.ready === true
      && receipt.pid === child?.pid
      && receipt.workerInstanceId === activeWorkerInstanceId
      && Array.isArray(receipt.forbiddenNamesPresent)
      && receipt.forbiddenNamesPresent.length === 0;
    if (ready) await archiveGenerationReceipt(receipt);
    return ready;
  } catch {
    return false;
  }
}

async function handleKill(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expectedToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!authenticated(request, expectedToken)) {
    sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
    return;
  }
  let payload: KillRequest;
  try { payload = await readJson(request); }
  catch {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  const receipt = await readCurrentReceipt();
  if (!workerReady || child?.pid === undefined || receipt.pid !== child.pid || receipt.workerInstanceId !== activeWorkerInstanceId
    || payload.pid !== receipt.pid || payload.procStartTicks !== receipt.procStartTicks || payload.workerInstanceId !== receipt.workerInstanceId) {
    sendJson(response, 409, { error: 'E2E_WORKER_IDENTITY_STALE' });
    return;
  }
  await archiveGenerationReceipt(receipt);
  if (payload.restart !== undefined && typeof payload.restart !== 'boolean') {
    sendJson(response, 422, { error: 'E2E_WORKER_RESTART_FLAG_INVALID' });
    return;
  }
  const shouldRestart = payload.restart !== false;
  restartRequested = shouldRestart;
  paused = !shouldRestart;
  workerReady = false;
  if (!child.kill('SIGKILL')) {
    restartRequested = false;
    paused = false;
    sendJson(response, 409, { error: 'E2E_WORKER_KILL_FAILED' });
    return;
  }
  for (const arm of hookArms.values()) {
    const payload = arm.payload;
    if (arm.state === 'triggered' && payload !== undefined && 'workerInstanceId' in payload
      && payload.workerInstanceId === receipt.workerInstanceId) {
      arm.state = 'worker_killed';
      arm.action = 'worker_sigkill';
      arm.waitingResponse?.destroy();
      arm.waitingResponse = undefined;
    }
  }
  await persistHookReceipt();
  sendJson(response, 202, {
    killed: { pid: receipt.pid, procStartTicks: receipt.procStartTicks, workerInstanceId: receipt.workerInstanceId, generation },
    restartScheduled: shouldRestart,
    nextGeneration: shouldRestart ? generation + 1 : null,
  });
}

async function handleResume(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expectedToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!authenticated(request, expectedToken)) {
    sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
    return;
  }
  if (!paused || workerReady || (child !== undefined && child.exitCode === null && child.signalCode === null)) {
    sendJson(response, 409, { error: 'E2E_WORKER_NOT_PAUSED' });
    return;
  }
  paused = false;
  await recordWorkerEvent({ event: 'worker.resume_requested', nextGeneration: generation + 1 });
  startWorker();
  sendJson(response, 202, { restartScheduled: true, nextGeneration: generation });
}

async function handleArmHook(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expectedToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!authenticated(request, expectedToken)) {
    sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
    return;
  }
  let body: Record<string, unknown>;
  try { body = await readJson(request); }
  catch {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  const hook = parseHookName(body.hook);
  const taskId = body.taskId;
  const idempotencyKey = body.idempotencyKey;
  const stepId = body.stepId;
  const sourceHook = hook === 'control-plane.after_ingest_intent_put_authority_committed'
    || hook === 'control-plane.after_source_object_put';
  const stepHook = hook === 'worker.before_complete_step'
    || hook === 'control-plane.after_complete_step_committed_before_response';
  if (hook === undefined
    || (sourceHook ? typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200
      : typeof taskId !== 'string' || !idPattern.test(taskId))
    || (stepId !== undefined && (typeof stepId !== 'string' || !idPattern.test(stepId)))
    || (stepHook && typeof stepId !== 'string')
    || (!stepHook && stepId !== undefined)) {
    sendJson(response, 422, { error: 'E2E_HOOK_ARM_INVALID' });
    return;
  }
  if ([...hookArms.values()].some((arm) => arm.hook === hook
    && (sourceHook ? arm.idempotencyKey === idempotencyKey : arm.taskId === taskId)
    && ['armed', 'triggered'].includes(arm.state))) {
    sendJson(response, 409, { error: 'E2E_HOOK_ALREADY_ARMED' });
    return;
  }
  const arm: HookArm = {
    armId: `hook_arm_${randomUUID()}`,
    hook,
    ...(sourceHook ? { idempotencyKey: String(idempotencyKey) } : { taskId: String(taskId) }),
    ...(typeof stepId === 'string' ? { stepId } : {}),
    state: 'armed',
    armedAt: new Date().toISOString(),
    waitingResponse: undefined,
  };
  hookArms.set(arm.armId, arm);
  await persistHookReceipt();
  sendJson(response, 201, hookProjection(arm));
}

async function handleHookState(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expectedToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!authenticated(request, expectedToken)) {
    sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const armId = url.searchParams.get('armId');
  const arm = armId === null ? undefined : hookArms.get(armId);
  if (arm === undefined) {
    sendJson(response, 404, { error: 'E2E_HOOK_ARM_NOT_FOUND' });
    return;
  }
  sendJson(response, 200, hookProjection(arm));
}

async function handleHookReached(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expectedToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!authenticated(request, expectedToken)) {
    sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
    return;
  }
  let body: Record<string, unknown>;
  try { body = await readJson(request); }
  catch {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  const payload = parseHookPayload(body);
  if (payload === undefined) {
    sendJson(response, 422, { error: 'E2E_HOOK_PAYLOAD_INVALID' });
    return;
  }
  const arm = [...hookArms.values()].find((candidate) => candidate.state === 'armed'
    && candidate.hook === payload.hook
    && ('taskId' in payload ? candidate.taskId === payload.taskId : candidate.idempotencyKey === payload.idempotencyKey)
    && (candidate.stepId === undefined || ('stepId' in payload && candidate.stepId === payload.stepId)));
  if (arm === undefined) {
    response.writeHead(204).end();
    return;
  }
  if (payload.hook.startsWith('worker.')
    && (child?.pid === undefined || !workerReady || !('workerInstanceId' in payload)
      || payload.workerInstanceId !== activeWorkerInstanceId)) {
    sendJson(response, 409, { error: 'E2E_HOOK_WORKER_IDENTITY_STALE' });
    return;
  }
  arm.state = 'triggered';
  arm.triggeredAt = new Date().toISOString();
  arm.triggerId = `hook_trigger_${randomUUID()}`;
  arm.payload = payload;
  arm.waitingResponse = response;
  response.once('close', () => {
    if (arm.waitingResponse !== response) return;
    arm.waitingResponse = undefined;
    if (arm.state === 'triggered' && arm.hook.startsWith('control-plane.')) {
      arm.state = 'control_plane_killed';
      arm.action = 'control_plane_sigkill';
      void persistHookReceipt();
    }
  });
  await persistHookReceipt();
}

async function handleReleaseHook(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const expectedToken = (await readFile(tokenFile, 'utf8')).trim();
  if (!authenticated(request, expectedToken)) {
    sendJson(response, 401, { error: 'E2E_SUPERVISOR_AUTH_REQUIRED' });
    return;
  }
  let body: Record<string, unknown>;
  try { body = await readJson(request); }
  catch {
    sendJson(response, 400, { error: 'E2E_SUPERVISOR_BODY_INVALID' });
    return;
  }
  const arm = typeof body.armId === 'string' ? hookArms.get(body.armId) : undefined;
  const action = body.action === undefined ? 'continue' : body.action;
  if (arm === undefined || arm.state !== 'triggered' || body.triggerId !== arm.triggerId || arm.waitingResponse === undefined
    || typeof action !== 'string' || !['continue', 'inject_error'].includes(action)
    || (action === 'inject_error' && arm.hook !== 'control-plane.after_source_object_put'
      && arm.hook !== 'control-plane.after_complete_step_committed_before_response')) {
    sendJson(response, 409, { error: 'E2E_HOOK_RELEASE_STALE' });
    return;
  }
  const blockedResponse = arm.waitingResponse;
  arm.waitingResponse = undefined;
  arm.state = action === 'inject_error' ? 'error_injected' : 'released';
  arm.action = action === 'inject_error' ? 'inject_error' : 'continue';
  await persistHookReceipt();
  const injectedCode = arm.hook === 'control-plane.after_complete_step_committed_before_response'
    ? 'E2E_COMPLETE_STEP_ACK_LOST'
    : 'E2E_PUT_RESPONSE_LOST';
  sendJson(blockedResponse, 200, action === 'inject_error'
    ? { action: 'inject_error', code: injectedCode, armId: arm.armId, triggerId: arm.triggerId }
    : { action: 'continue', released: true, armId: arm.armId, triggerId: arm.triggerId });
  sendJson(response, 200, hookProjection(arm));
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    void isReady().then((ready) => {
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready, generation, workerInstanceId: activeWorkerInstanceId }));
    });
    return;
  }
  if (request.method === 'POST' && request.url === '/test/kill-worker') {
    void handleKill(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: String(error) });
    });
    return;
  }
  if (request.method === 'POST' && request.url === '/test/resume-worker') {
    void handleResume(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/hooks/arm') {
    void handleArmHook(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === 'GET' && request.url?.startsWith('/test/hooks/state?') === true) {
    void handleHookState(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/hooks/reached') {
    void handleHookReached(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  if (request.method === 'POST' && request.url === '/test/hooks/release') {
    void handleReleaseHook(request, response).catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(healthPort, '127.0.0.1', resolve);
});
startWorker();

async function closeServer(): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  restartRequested = false;
  paused = false;
  for (const arm of hookArms.values()) {
    if (arm.waitingResponse !== undefined) {
      sendJson(arm.waitingResponse, 503, { error: 'E2E_SUPERVISOR_STOPPING' });
      arm.waitingResponse = undefined;
    }
  }
  if (child?.exitCode === null && child.signalCode === null) child.kill(signal);
  void closeServer();
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('beforeExit', () => {
  if (unexpectedExit) process.exitCode = 1;
});
