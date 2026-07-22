import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import { readProcessPair, writeRecoveryCase } from './recovery-matrix-support.js';

const { Pool } = pg;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = requiredEnvironment('GENEWAY_E2E_DATABASE_URL');
const composeProject = requiredEnvironment('COMPOSE_PROJECT_NAME');
const runId = requiredEnvironment('GENEWAY_RUN_ID');
const workerTokenFile = requiredEnvironment('GENEWAY_WORKER_TOKEN_FILE');
const workerSocketPath = requiredEnvironment('GENEWAY_WORKER_SOCKET_PATH');
const workerHealthPort = Number(requiredEnvironment('GENEWAY_WORKER_HEALTH_PORT'));
if (!Number.isInteger(workerHealthPort) || workerHealthPort < 1 || workerHealthPort > 65_535) {
  throw new Error('GENEWAY_WORKER_HEALTH_PORT is invalid');
}

const sourcePath = path.resolve(process.cwd(), 'scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt');
const sourceSha256 = '3b5ee113e79ab2afb504898cf962da10f7d31e62ddb89370e645c2d32f48ca06';
const hookReceiptPath = `/tmp/geneway-runs/${runId}/process-boundaries/e2e-hooks.json`;

type WorkerReceipt = Readonly<{
  role: 'worker';
  phase: 'ready';
  ready: true;
  pid: number;
  procStartTicks: string;
  workerInstanceId: string;
}>;

type WorkerHookPayload = Readonly<{
  protocolVersion: 'geneway-e2e-hook/1';
  hook: 'worker.before_complete_step';
  taskId: string;
  workerInstanceId: string;
  deliveryId: string;
  eventId: string;
  executionAttemptId: string;
  fencingToken: number;
  stepId: string;
  stepAttemptId: string;
  stepFencingToken: number;
}>;

type ReportHookPayload = Readonly<{
  protocolVersion: 'geneway-e2e-hook/1';
  hook: 'control-plane.after_report_object_verified';
  taskId: string;
  workerInstanceId: string;
  deliveryId: string;
  eventId: string;
  executionAttemptId: string;
  fencingToken: number;
  reportIntentId: string;
  artifactId: string;
  storageKey: string;
  contentSha256: string;
}>;

type HookPayload = WorkerHookPayload | ReportHookPayload;
type HookState = Readonly<{
  armId: string;
  hook: HookPayload['hook'];
  taskId: string;
  stepId?: string;
  state: 'armed' | 'triggered' | 'released' | 'worker_killed';
  faultTriggered: boolean;
  released: boolean;
  triggerId: string | null;
  payload: HookPayload | null;
}>;

type KillResult = Readonly<{
  killed: Readonly<{ pid: number; procStartTicks: string; workerInstanceId: string; generation: number }>;
  nextGeneration: number;
}>;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function locateStorageOracle(): string {
  const located = spawnSync('docker', [
    'ps', '--filter', `label=com.docker.compose.project=${composeProject}`,
    '--filter', 'label=com.docker.compose.service=storage-oracle', '--format', '{{.ID}}',
  ], { encoding: 'utf8' });
  if (located.status !== 0) throw new Error(`Unable to locate storage oracle container: ${located.stderr}`);
  const containerId = located.stdout.trim();
  if (containerId.length === 0 || containerId.includes('\n')) throw new Error('Storage oracle container is missing or ambiguous');
  return containerId;
}

function runStorageOracle(key: string): SpawnSyncReturns<string> {
  return spawnSync('docker', [
    'exec', '-i', locateStorageOracle(), './node_modules/.bin/tsx', 'scripts/storage-oracle-cli.ts', 'get', key,
  ], { encoding: 'utf8' });
}

function storageOracle(key: string): Readonly<{ bytesBase64?: string; contentSha256?: string | null }> {
  const executed = runStorageOracle(key);
  if (executed.status !== 0) throw new Error(`Storage oracle get failed: ${executed.stderr}`);
  return JSON.parse(executed.stdout) as Readonly<{ bytesBase64?: string; contentSha256?: string | null }>;
}

function storageObjectExists(key: string): boolean {
  const executed = runStorageOracle(key);
  if (executed.status === 0) return true;
  const error = `${executed.stdout}\n${executed.stderr}`;
  if (/NoSuchKey|NotFound|specified key does not exist|does not exist/iu.test(error)) return false;
  throw new Error(`Storage oracle could not determine object existence: ${error}`);
}

function composeServiceLogs(service: string): string {
  const located = spawnSync('docker', [
    'ps', '-aq', '--filter', `label=com.docker.compose.project=${composeProject}`,
    '--filter', `label=com.docker.compose.service=${service}`,
  ], { encoding: 'utf8' });
  const containerId = located.status === 0 ? located.stdout.trim() : '';
  if (containerId.length === 0 || containerId.includes('\n')) {
    return `unable to locate ${service}: ${located.stderr.trim() || 'container missing or ambiguous'}`;
  }
  const captured = spawnSync('docker', ['logs', '--timestamps', '--tail', '200', containerId], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  });
  return [`service=${service} container=${containerId} status=${String(captured.status)}`, captured.stdout, captured.stderr]
    .filter((part) => part.length > 0).join('\n');
}

async function uploadAndCreateTask(page: Page, message: string): Promise<Readonly<{ taskId: string; taskCard: Locator }>> {
  const sourceBytes = await readFile(sourcePath);
  expect(sha256(sourceBytes)).toBe(sourceSha256);
  await page.goto('/conversations/new?capability=solution.analysis.v1');
  await page.getByTestId('artifact-upload-input').setInputFiles({
    name: 'solution-analysis-demo-v2.txt', mimeType: 'text/plain', buffer: sourceBytes,
  });
  const sourceCard = page.getByTestId('artifact-card').filter({ hasText: 'solution-analysis-demo-v2.txt' });
  await expect(sourceCard).toHaveCount(1);
  await sourceCard.getByRole('button', { name: '选择用于分析' }).click();
  await page.getByLabel('专家路线').selectOption('team.solution.core');
  await page.getByLabel('给小纬发消息').fill(message);
  await page.getByRole('button', { name: '发送' }).click();
  const taskCard = page.getByTestId('task-card');
  const taskId = await taskCard.getAttribute('data-task-id');
  expect(taskId).toBeTruthy();
  await page.getByRole('button', { name: '关闭' }).click();
  return { taskId: taskId ?? '', taskCard };
}

async function readWorkerReceipt(): Promise<WorkerReceipt> {
  return JSON.parse(await readFile(`/tmp/geneway-runs/${runId}/process-boundaries/worker.json`, 'utf8')) as WorkerReceipt;
}

function processIdentityMatches(receipt: WorkerReceipt): boolean {
  try {
    const raw = readFileSync(`/proc/${String(receipt.pid)}/stat`, 'utf8');
    const closingParenthesis = raw.lastIndexOf(')');
    return closingParenthesis > 0 && raw.slice(closingParenthesis + 1).trim().split(/\s+/u)[19] === receipt.procStartTicks;
  } catch { return false; }
}

async function waitUntil<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function supervisorRequest<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Readonly<{ status: number; body: T }>> {
  const token = (await readFile(workerTokenFile, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${String(workerHealthPort)}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json() as T;
  return { status: response.status, body: payload };
}

async function armHook(taskId: string, hook: HookPayload['hook'], stepId?: string): Promise<HookState> {
  const response = await supervisorRequest<HookState>('POST', '/test/hooks/arm', {
    hook, taskId, ...(stepId === undefined ? {} : { stepId }),
  });
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({ hook, taskId, state: 'armed', faultTriggered: false });
  return response.body;
}

async function readHookState(armId: string): Promise<HookState> {
  const response = await supervisorRequest<HookState>('GET', `/test/hooks/state?armId=${encodeURIComponent(armId)}`);
  expect(response.status).toBe(200);
  return response.body;
}

async function waitForTriggeredHook<T extends HookPayload>(arm: HookState, hook: T['hook']): Promise<HookState & Readonly<{ payload: T }>> {
  return waitUntil(async () => {
    const state = await readHookState(arm.armId);
    if (!state.faultTriggered || state.state !== 'triggered' || state.triggerId === null || state.payload?.hook !== hook) return undefined;
    return state as HookState & Readonly<{ payload: T }>;
  }, 20_000, `${hook} hook`);
}

async function releaseHook(state: HookState): Promise<void> {
  if (state.state !== 'triggered' || state.triggerId === null) return;
  const response = await supervisorRequest<HookState>('POST', '/test/hooks/release', {
    armId: state.armId, triggerId: state.triggerId,
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ armId: state.armId, state: 'released', faultTriggered: true, released: true });
}

async function releaseHookIfWaiting(arm: HookState | undefined): Promise<void> {
  if (arm === undefined) return;
  try { await releaseHook(await readHookState(arm.armId)); }
  catch { /* Best-effort unblocking during test teardown. */ }
}

async function killWorker(receipt: WorkerReceipt): Promise<KillResult> {
  const response = await supervisorRequest<KillResult>('POST', '/test/kill-worker', {
    pid: receipt.pid, procStartTicks: receipt.procStartTicks, workerInstanceId: receipt.workerInstanceId,
  });
  expect(response.status).toBe(202);
  expect(response.body.killed).toMatchObject({
    pid: receipt.pid, procStartTicks: receipt.procStartTicks, workerInstanceId: receipt.workerInstanceId,
  });
  return response.body;
}

async function waitForRestart(previous: WorkerReceipt): Promise<WorkerReceipt> {
  return waitUntil(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${String(workerHealthPort)}/health`);
      if (!response.ok) return undefined;
      const receipt = await readWorkerReceipt();
      return receipt.ready && receipt.pid !== previous.pid && receipt.workerInstanceId !== previous.workerInstanceId ? receipt : undefined;
    } catch { return undefined; }
  }, 10_000, 'a replacement Worker generation');
}

async function staleReadInput(payload: ReportHookPayload): Promise<Readonly<{ status: number; body: unknown }>> {
  const token = (await readFile(workerTokenFile, 'utf8')).trim();
  const body = JSON.stringify({
    command: 'read_input',
    protocolVersion: 'gate0.2a-worker-command/1',
    workerInstanceId: payload.workerInstanceId,
    deliveryId: payload.deliveryId,
    eventId: payload.eventId,
    attemptId: payload.executionAttemptId,
    fencingToken: payload.fencingToken,
  });
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: workerSocketPath,
      path: '/internal/worker/v1/commands',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: unknown) => {
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else reject(new Error('stale Worker command returned an unsupported body chunk'));
      });
      response.once('error', reject);
      response.once('end', () => {
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
        catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
        resolve({ status: response.statusCode ?? 0, body: decoded });
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error('stale Worker command timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

test('真实 Worker 在已认领步骤的确定性故障点被 kill 后按 checkpoint reclaim 并只发布一次', async ({ page, request }) => {
  test.setTimeout(90_000);
  const pool = new Pool({ connectionString: databaseUrl });
  let hookArm: HookState | undefined;
  try {
    const processBefore = await readProcessPair();
    const initialWorker = await readWorkerReceipt();
    expect(processIdentityMatches(initialWorker)).toBe(true);
    const { taskId, taskCard } = await uploadAndCreateTask(page, '请运行可恢复的专家团方案分析');
    hookArm = await armHook(taskId, 'worker.before_complete_step', 'requirement_extract');
    await page.getByRole('button', { name: '批准并运行模拟任务' }).click();
    const hook = await waitForTriggeredHook<WorkerHookPayload>(hookArm, 'worker.before_complete_step');
    expect(hook.payload).toMatchObject({
      taskId,
      workerInstanceId: initialWorker.workerInstanceId,
      stepId: 'requirement_extract',
    });

    const checkpoint = await pool.query<{
      task_status: string; attempt_status: string; attempt_id: string; worker_instance_id: string; fencing_token: string;
      delivery_id: string; event_id: string; delivery_worker: string; delivery_fence: string; inbox_worker: string;
      inbox_fence: string; step_status: string; step_attempt_id: string; step_fencing_token: string; completed_steps: string;
    }>(`SELECT t.status task_status,a.status attempt_status,a.id attempt_id,a.worker_instance_id,a.fencing_token::text,
      d.id delivery_id,d.event_id,d.worker_instance_id delivery_worker,d.fencing_token::text delivery_fence,
      i.worker_instance_id inbox_worker,i.fencing_token::text inbox_fence,
      s.status step_status,s.attempt_id step_attempt_id,s.fencing_token::text step_fencing_token,
      (SELECT count(*)::text FROM business_task_steps complete_step
        WHERE complete_step.tenant_id=t.tenant_id AND complete_step.business_task_id=t.id AND complete_step.status='completed') completed_steps
      FROM business_tasks t
      JOIN execution_attempts a ON a.tenant_id=t.tenant_id AND a.id=t.current_execution_attempt_id
      JOIN outbox_deliveries d ON d.tenant_id=t.tenant_id AND d.execution_attempt_id=a.id
      JOIN inbox_events i ON i.tenant_id=d.tenant_id AND i.consumer=d.consumer AND i.event_id=d.event_id
      JOIN business_task_steps s ON s.tenant_id=t.tenant_id AND s.business_task_id=t.id AND s.step_id=$2
      WHERE t.tenant_id='tenant_local' AND t.id=$1`, [taskId, hook.payload.stepId]);
    expect(checkpoint.rows).toHaveLength(1);
    expect(checkpoint.rows[0]).toEqual(expect.objectContaining({
      task_status: 'running', attempt_status: 'running', attempt_id: hook.payload.executionAttemptId,
      worker_instance_id: hook.payload.workerInstanceId, fencing_token: String(hook.payload.fencingToken),
      delivery_id: hook.payload.deliveryId, event_id: hook.payload.eventId,
      delivery_worker: hook.payload.workerInstanceId, delivery_fence: String(hook.payload.fencingToken),
      inbox_worker: hook.payload.workerInstanceId, inbox_fence: String(hook.payload.fencingToken),
      step_status: 'running', step_attempt_id: hook.payload.stepAttemptId,
      step_fencing_token: String(hook.payload.stepFencingToken), completed_steps: '1',
    }));

    const killed = await killWorker(initialWorker);
    await waitUntil(() => processIdentityMatches(initialWorker) ? undefined : true, 5_000, 'the killed Worker process to exit');
    const replacementWorker = await waitForRestart(initialWorker);
    expect(processIdentityMatches(replacementWorker)).toBe(true);
    expect(replacementWorker.procStartTicks).not.toBe(initialWorker.procStartTicks);
    const generationReceipt = await waitUntil(async () => {
      try {
        return JSON.parse(await readFile(
          `/tmp/geneway-runs/${runId}/process-boundaries/worker-generation-${String(killed.nextGeneration)}.json`, 'utf8',
        )) as Readonly<{ generation: number; pid: number; procStartTicks: string; workerInstanceId: string }>;
      } catch { return undefined; }
    }, 5_000, 'replacement Worker process receipt');
    expect(generationReceipt).toMatchObject({
      generation: killed.nextGeneration,
      pid: replacementWorker.pid,
      procStartTicks: replacementWorker.procStartTicks,
      workerInstanceId: replacementWorker.workerInstanceId,
    });
    const killedHook = await readHookState(hook.armId);
    expect(killedHook).toMatchObject({ state: 'worker_killed', faultTriggered: true, released: false });

    await expect(page.getByTestId('result-card')).toBeVisible({ timeout: 45_000 });
    await expect(taskCard).toContainText('已完成 7 / 7 个步骤');
    const snapshotResponse = await request.get(`/api/business-tasks/${taskId}`);
    expect(snapshotResponse.ok()).toBeTruthy();
    const snapshot = await snapshotResponse.json() as {
      status: string; claims: readonly unknown[]; evidence: readonly unknown[];
      artifacts: readonly { kind: string; contentSha256: string }[];
    };
    expect(snapshot.status).toBe('completed');
    expect(snapshot.claims).toHaveLength(2);
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.artifacts.filter((artifact) => artifact.kind === 'simulation_report')).toHaveLength(1);

    const correlation = await pool.query<{
      status: string; current_worker: string; task_fence: string; attempt_count: string; distinct_workers: string;
      superseded_attempts: string; completed_attempts: string; delivery_count: string; delivery_worker: string;
      delivery_fence: string; inbox_worker: string; inbox_fence: string; candidate_count: string;
      published_claims: string; report_count: string; report_storage_key: string; report_hash: string;
      ready_snapshot_count: string;
    }>(`SELECT t.status,current_attempt.worker_instance_id current_worker,t.execution_fencing_token::text task_fence,
      (SELECT count(*)::text FROM execution_attempts a WHERE a.tenant_id=t.tenant_id AND a.business_task_id=t.id) attempt_count,
      (SELECT count(DISTINCT a.worker_instance_id)::text FROM execution_attempts a WHERE a.tenant_id=t.tenant_id AND a.business_task_id=t.id) distinct_workers,
      (SELECT count(*)::text FROM execution_attempts a WHERE a.tenant_id=t.tenant_id AND a.business_task_id=t.id AND a.status='superseded') superseded_attempts,
      (SELECT count(*)::text FROM execution_attempts a WHERE a.tenant_id=t.tenant_id AND a.business_task_id=t.id AND a.status='completed') completed_attempts,
      delivery.delivery_count::text,delivery.worker_instance_id delivery_worker,delivery.fencing_token::text delivery_fence,
      inbox.worker_instance_id inbox_worker,inbox.fencing_token::text inbox_fence,
      (SELECT count(*)::text FROM attempt_output_candidates candidate WHERE candidate.tenant_id=t.tenant_id AND candidate.business_task_id=t.id) candidate_count,
      (SELECT count(*)::text FROM claims claim WHERE claim.tenant_id=t.tenant_id AND claim.business_task_id=t.id AND claim.status='published') published_claims,
      (SELECT count(*)::text FROM artifacts artifact WHERE artifact.tenant_id=t.tenant_id AND artifact.business_task_id=t.id AND artifact.kind='simulation_report') report_count,
      (SELECT count(*)::text FROM document_snapshots snapshot WHERE snapshot.tenant_id=t.tenant_id AND snapshot.id=t.input_snapshot->>'documentSnapshotId') ready_snapshot_count,
      report.storage_key report_storage_key,report.content_sha256 report_hash
      FROM business_tasks t
      JOIN execution_attempts current_attempt ON current_attempt.tenant_id=t.tenant_id AND current_attempt.id=t.current_execution_attempt_id
      JOIN outbox_deliveries delivery ON delivery.tenant_id=t.tenant_id AND delivery.business_task_id=t.id
      JOIN inbox_events inbox ON inbox.tenant_id=delivery.tenant_id AND inbox.consumer=delivery.consumer AND inbox.event_id=delivery.event_id
      JOIN report_publish_intents report ON report.tenant_id=t.tenant_id AND report.business_task_id=t.id
      WHERE t.tenant_id='tenant_local' AND t.id=$1`, [taskId]);
    expect(correlation.rows).toHaveLength(1);
    const row = correlation.rows[0];
    expect(row).toEqual(expect.objectContaining({
      status: 'completed', current_worker: replacementWorker.workerInstanceId,
      attempt_count: '2', distinct_workers: '2', superseded_attempts: '1', completed_attempts: '1',
      delivery_count: '2', delivery_worker: replacementWorker.workerInstanceId,
      inbox_worker: replacementWorker.workerInstanceId, candidate_count: '1', published_claims: '1', report_count: '1',
    }));
    expect(row?.task_fence).toBe(row?.delivery_fence);
    expect(row?.task_fence).toBe(row?.inbox_fence);
    const storedReport = storageOracle(row?.report_storage_key ?? 'missing-report');
    expect(storedReport.contentSha256).toBe(row?.report_hash);
    expect(sha256(Buffer.from(storedReport.bytesBase64 ?? '', 'base64'))).toBe(row?.report_hash);

    const hookReceipt = JSON.parse(await readFile(hookReceiptPath, 'utf8')) as Readonly<{
      schemaVersion: string;
      runId: string;
      hooks: readonly HookState[];
    }>;
    expect(hookReceipt).toMatchObject({ schemaVersion: 'geneway-e2e-hooks/1', runId });
    expect(hookReceipt.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hook: 'worker.before_complete_step',
        taskId,
        state: 'worker_killed',
        faultTriggered: true,
        payload: expect.objectContaining({
          executionAttemptId: hook.payload.executionAttemptId,
          stepAttemptId: hook.payload.stepAttemptId,
        }),
      }),
    ]));
    const processAfter = await readProcessPair();
    await writeRecoveryCase({
      caseId: 'after_step_side_effect_before_completion',
      faultTriggered: true,
      trigger: {
        hook: 'worker.before_complete_step',
        action: 'worker_sigkill',
        stepId: hook.payload.stepId,
        oldAttemptId: hook.payload.executionAttemptId,
        replacementGeneration: generationReceipt.generation,
      },
      entityIds: {
        taskId,
        deliveryId: hook.payload.deliveryId,
        eventId: hook.payload.eventId,
        attemptIds: [hook.payload.executionAttemptId, row?.current_worker ?? replacementWorker.workerInstanceId],
      },
      processBefore,
      processAfter,
      final: {
        taskStatus: snapshot.status,
        publishedClaims: Number(row?.published_claims ?? '0'),
        reportArtifacts: Number(row?.report_count ?? '0'),
        readySnapshots: Number(row?.ready_snapshot_count ?? '0'),
        workerRestarted: processBefore.worker.pid !== processAfter.worker.pid,
      },
      evidenceRefs: [
        hookReceiptPath,
        `/tmp/geneway-runs/${runId}/process-boundaries/worker-generation-${String(generationReceipt.generation)}.json`,
      ],
    });
  } finally {
    await releaseHookIfWaiting(hookArm);
    await pool.end();
  }
});

test('报告对象校验后取消会拒绝旧 Worker、删除孤儿对象且不发布 Claim 或报告', async ({ page, request }) => {
  test.setTimeout(90_000);
  const pool = new Pool({ connectionString: databaseUrl });
  let hookArm: HookState | undefined;
  try {
    const processBefore = await readProcessPair();
    const { taskId } = await uploadAndCreateTask(page, '请启动后由我在报告提交窗口取消本次专家团模拟分析');
    hookArm = await armHook(taskId, 'control-plane.after_report_object_verified');
    await page.getByRole('button', { name: '批准并运行模拟任务' }).click();
    const hook = await waitForTriggeredHook<ReportHookPayload>(hookArm, 'control-plane.after_report_object_verified');
    expect(hook.payload.taskId).toBe(taskId);

    const verifiedIntent = await pool.query<{
      status: string; state_version: string; execution_attempt_id: string; artifact_id: string;
      storage_key: string; content_sha256: string; etag_observed: string | null;
    }>(`SELECT status,state_version::text,execution_attempt_id,artifact_id,storage_key,content_sha256,etag_observed
      FROM report_publish_intents WHERE tenant_id='tenant_local' AND id=$1 AND business_task_id=$2`, [
      hook.payload.reportIntentId, taskId,
    ]);
    expect(verifiedIntent.rows).toEqual([expect.objectContaining({
      status: 'object_verified',
      execution_attempt_id: hook.payload.executionAttemptId,
      artifact_id: hook.payload.artifactId,
      storage_key: hook.payload.storageKey,
      content_sha256: hook.payload.contentSha256,
      etag_observed: expect.any(String),
    })]);
    expect(storageObjectExists(hook.payload.storageKey)).toBe(true);

    const cancelButton = page.getByTestId('cancel-task-button');
    await expect(cancelButton).toBeEnabled();
    await cancelButton.click();
    await expect(page.getByTestId('canceled-task-state')).toContainText('模拟任务已取消');
    await expect(cancelButton).toBeDisabled();
    await expect(page.getByTestId('published-claim')).toHaveCount(0);
    await expect(page.getByTestId('report-artifact-item')).toHaveCount(0);

    const staleCommand = await staleReadInput(hook.payload);
    expect(staleCommand.status).toBe(409);
    expect(staleCommand.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'STALE_OR_UNAUTHORIZED_WORKER_COMMAND' }),
    }));

    const afterCancel = await pool.query<{
      task_status: string; attempt_status: string; delivery_status: string; inbox_status: string;
      claim_count: string; evidence_count: string; candidate_count: string; report_count: string;
      intent_status: string; failure_code: string | null; ready_snapshot_count: string;
    }>(`SELECT t.status task_status,a.status attempt_status,d.status delivery_status,i.status inbox_status,
      (SELECT count(*)::text FROM claims c WHERE c.tenant_id=t.tenant_id AND c.business_task_id=t.id) claim_count,
      (SELECT count(*)::text FROM evidence_items e WHERE e.tenant_id=t.tenant_id AND e.business_task_id=t.id) evidence_count,
      (SELECT count(*)::text FROM attempt_output_candidates candidate WHERE candidate.tenant_id=t.tenant_id AND candidate.business_task_id=t.id) candidate_count,
      (SELECT count(*)::text FROM artifacts artifact WHERE artifact.tenant_id=t.tenant_id AND artifact.business_task_id=t.id AND artifact.kind='simulation_report') report_count,
      (SELECT count(*)::text FROM document_snapshots snapshot WHERE snapshot.tenant_id=t.tenant_id AND snapshot.id=t.input_snapshot->>'documentSnapshotId') ready_snapshot_count,
      intent.status intent_status,intent.failure_code
      FROM business_tasks t
      JOIN execution_attempts a ON a.tenant_id=t.tenant_id AND a.id=t.current_execution_attempt_id
      JOIN outbox_deliveries d ON d.tenant_id=a.tenant_id AND d.execution_attempt_id=a.id
      JOIN inbox_events i ON i.tenant_id=d.tenant_id AND i.consumer=d.consumer AND i.event_id=d.event_id
      JOIN report_publish_intents intent ON intent.tenant_id=t.tenant_id AND intent.business_task_id=t.id
      WHERE t.tenant_id='tenant_local' AND t.id=$1`, [taskId]);
    expect(afterCancel.rows).toHaveLength(1);
    expect(afterCancel.rows[0]).toEqual(expect.objectContaining({
      task_status: 'canceled', attempt_status: 'canceled', delivery_status: 'canceled', inbox_status: 'canceled',
      claim_count: '0', evidence_count: '0', candidate_count: '1', report_count: '0',
      failure_code: 'TASK_CANCELED',
    }));
    expect(['reconcile_required', 'delete_pending', 'deleted']).toContain(afterCancel.rows[0]?.intent_status);

    await releaseHook(hook);
    let finalIntent: Readonly<{
      status: string; failure_code: string | null; deleted_at: Date | null; storage_key: string;
    }>;
    try {
      finalIntent = await waitUntil(async () => {
        const result = await pool.query<{
          status: string; failure_code: string | null; deleted_at: Date | null; storage_key: string;
        }>(`SELECT status,failure_code,deleted_at,storage_key FROM report_publish_intents
          WHERE tenant_id='tenant_local' AND id=$1`, [hook.payload.reportIntentId]);
        const row = result.rows[0];
        return row?.status === 'deleted' ? row : undefined;
      }, 20_000, 'the canceled report intent to reconcile and delete');
    } catch (error) {
      throw new Error(`${String(error)}\n${composeServiceLogs('storage-reconciler')}\n${composeServiceLogs('storage-reconciliation-adapter')}`);
    }
    expect(finalIntent).toMatchObject({
      status: 'deleted', failure_code: 'TASK_CANCELED', storage_key: hook.payload.storageKey,
      deleted_at: expect.any(Date),
    });
    expect(storageObjectExists(hook.payload.storageKey)).toBe(false);

    await page.reload();
    await expect(page.getByTestId('task-id')).toHaveText(taskId);
    await expect(page.getByTestId('canceled-task-state')).toContainText('模拟任务已取消');
    await expect(page.getByTestId('cancel-task-button')).toBeDisabled();
    await expect(page.getByTestId('published-claim')).toHaveCount(0);
    await expect(page.getByTestId('report-artifact-item')).toHaveCount(0);
    const response = await request.get(`/api/business-tasks/${taskId}`);
    expect(response.ok()).toBeTruthy();
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      status: 'canceled', claims: [], evidence: [],
      artifacts: expect.not.arrayContaining([expect.objectContaining({ kind: 'simulation_report' })]),
    }));

    const hookReceipt = JSON.parse(await readFile(hookReceiptPath, 'utf8')) as Readonly<{
      schemaVersion: string;
      runId: string;
      hooks: readonly HookState[];
    }>;
    expect(hookReceipt).toMatchObject({ schemaVersion: 'geneway-e2e-hooks/1', runId });
    expect(hookReceipt.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hook: 'control-plane.after_report_object_verified', taskId, state: 'released', faultTriggered: true, released: true,
        payload: expect.objectContaining({ reportIntentId: hook.payload.reportIntentId, storageKey: hook.payload.storageKey }),
      }),
    ]));
    const processAfter = await readProcessPair();
    await writeRecoveryCase({
      caseId: 'cancel_vs_publish',
      faultTriggered: true,
      trigger: {
        hook: 'control-plane.after_report_object_verified',
        action: 'continue_after_cancel',
        staleWorkerStatus: staleCommand.status,
      },
      entityIds: {
        taskId,
        reportIntentId: hook.payload.reportIntentId,
        artifactId: hook.payload.artifactId,
        attemptId: hook.payload.executionAttemptId,
      },
      processBefore,
      processAfter,
      final: {
        taskStatus: afterCancel.rows[0]?.task_status ?? 'missing',
        publishedClaims: Number(afterCancel.rows[0]?.claim_count ?? '0'),
        reportArtifacts: Number(afterCancel.rows[0]?.report_count ?? '0'),
        readySnapshots: Number(afterCancel.rows[0]?.ready_snapshot_count ?? '0'),
        latePublishRejected: staleCommand.status === 409,
      },
      evidenceRefs: [hookReceiptPath],
    });
  } finally {
    await releaseHookIfWaiting(hookArm);
    await pool.end();
  }
});
