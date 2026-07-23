import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const executeFile = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = required('GENEWAY_E2E_DATABASE_URL');
const tokenFile = required('GENEWAY_WORKER_TOKEN_FILE');
const runId = required('GENEWAY_RUN_ID');
const controlPlaneSupervisorPort = Number(required('GENEWAY_CONTROL_PLANE_SUPERVISOR_PORT'));
const workerSupervisorPort = Number(required('GENEWAY_WORKER_HEALTH_PORT'));
if (!Number.isInteger(controlPlaneSupervisorPort) || !Number.isInteger(workerSupervisorPort)) {
  throw new Error('Gate 0.2B.3 recovery requires test supervisor ports');
}

const pool = new Pool({ connectionString: databaseUrl });
const origin = `http://localhost:${required('GENEWAY_WEB_PORT')}`;

type WorkerReceipt = Readonly<{
  pid: number; procStartTicks: string; workerInstanceId: string; ready: true;
}>;
type HookState = Readonly<{
  armId: string; state: 'armed' | 'triggered' | 'released' | 'worker_killed';
  triggerId: string | null; faultTriggered: boolean;
  payload: null | Readonly<{ taskId: string; stepId: string; workerInstanceId: string; executionAttemptId: string }>;
}>;

async function supervisor(port: number, route: string, body?: unknown, method: 'GET' | 'POST' = 'POST') {
  const token = (await readFile(tokenFile, 'utf8')).trim();
  return fetch(`http://127.0.0.1:${String(port)}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function post(request: APIRequestContext, url: string, key: string, data?: unknown) {
  return request.post(url, { headers: { origin, 'idempotency-key': key }, ...(data === undefined ? {} : { data }) });
}

async function waitForSupervisor(port: number): Promise<void> {
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${String(port)}/health`)).status; }
    catch { return 0; }
  }, { timeout: 20_000 }).toBe(200);
}

async function openProductRoute(page: Page, route: string): Promise<void> {
  await expect.poll(async () => {
    const response = await page.goto(route);
    return response?.status() === 200 && await page.getByTestId('product-shell').count() === 1;
  }, { timeout: 20_000 }).toBe(true);
}

async function readWorkerReceipt(): Promise<WorkerReceipt> {
  return JSON.parse(await readFile(`/tmp/geneway-runs/${runId}/process-boundaries/worker.json`, 'utf8')) as WorkerReceipt;
}

async function armHook(taskId: string, stepId: string): Promise<HookState> {
  const response = await supervisor(workerSupervisorPort, '/test/hooks/arm', {
    hook: 'worker.before_complete_step', taskId, stepId,
  });
  const body = await response.text();
  expect(response.status, body).toBe(201);
  return JSON.parse(body) as HookState;
}

async function readHook(armId: string): Promise<HookState> {
  const response = await supervisor(workerSupervisorPort, `/test/hooks/state?armId=${encodeURIComponent(armId)}`, undefined, 'GET');
  expect(response.status).toBe(200);
  return response.json() as Promise<HookState>;
}

async function waitForHook(arm: HookState): Promise<HookState & Readonly<{ payload: NonNullable<HookState['payload']> }>> {
  let observed: HookState | undefined;
  await expect.poll(async () => {
    observed = await readHook(arm.armId);
    return observed.state;
  }, { timeout: 20_000 }).toBe('triggered');
  if (observed?.payload === null || observed?.payload === undefined) throw new Error('Worker hook payload is missing');
  return observed as HookState & Readonly<{ payload: NonNullable<HookState['payload']> }>;
}

async function releaseHook(hook: HookState): Promise<void> {
  if (hook.triggerId === null) throw new Error('Triggered hook has no triggerId');
  const response = await supervisor(workerSupervisorPort, '/test/hooks/release', {
    armId: hook.armId, triggerId: hook.triggerId,
  });
  expect(response.status, await response.text()).toBe(200);
}

async function exceptionTask(request: APIRequestContext, exceptionType: string, key: string) {
  const row = await pool.query<{ id: string }>('SELECT id FROM business_exceptions WHERE exception_type=$1', [exceptionType]);
  const exceptionId = row.rows[0]?.id;
  if (exceptionId === undefined) throw new Error(`Missing ${exceptionType} exception fixture`);
  const detailResponse = await request.get(`/api/business-exceptions/${exceptionId}`);
  const detail = await detailResponse.json() as { aggregateVersion: number; status: string };
  const acknowledged = detail.status === 'open'
    ? await post(request, `/api/business-exceptions/${exceptionId}/acknowledge`, `${key}-ack`, { aggregateVersion: detail.aggregateVersion })
    : detailResponse;
  const current = await acknowledged.json() as { aggregateVersion: number };
  const created = await post(request, `/api/business-exceptions/${exceptionId}/analysis-task`, `${key}-analysis`, {
    aggregateVersion: current.aggregateVersion,
    requestedExpertTarget: { mode: 'auto' },
    idempotencyKey: `${key}-analysis`,
  });
  expect(created.status(), await created.text()).toBe(201);
  return created.json() as Promise<{ taskId: string }>;
}

async function approveAndExecute(request: APIRequestContext, task: { taskId: string }, key: string) {
  const snapshot = await (await request.get(`/api/business-tasks/${task.taskId}`)).json() as {
    approval: { id: string; version: number; subjectDigest: string };
  };
  expect((await post(request, `/api/approvals/${snapshot.approval.id}/decisions`, `${key}-approve`, { decision: 'approved' })).status()).toBe(200);
  const execute = await post(request, `/api/business-tasks/${task.taskId}/execute`, `${key}-execute`, {
    expectedApprovalVersion: snapshot.approval.version,
    expectedApprovalSubjectDigest: snapshot.approval.subjectDigest,
  });
  expect(execute.status(), await execute.text()).toBe(200);
}

test.describe.serial('Gate 0.2B.3 recovery authenticity', () => {
  test.beforeAll(async () => {
    await pool.query(`INSERT INTO control_plane_database_metadata (singleton,is_non_production,environment_name)
      VALUES (true,true,'gate02b3-recovery') ON CONFLICT (singleton) DO UPDATE SET is_non_production=true`);
    await pool.query(`INSERT INTO resource_scopes (tenant_id,user_id,resource_scope)
      VALUES ('tenant_local','user_local','factory-01/workshop-machining/line-02') ON CONFLICT DO NOTHING`);
    await executeFile(process.execPath, ['--import', 'tsx', 'scripts/seed-gate0.2b-fixtures.ts'], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, GENEWAY_TENANT_ID: 'tenant_local' },
    });
  });
  test.afterAll(async () => pool.end());

  test('初次成功后 Control Plane 真暂停，离线状态可恢复到同一路由', async ({ page }, testInfo) => {
    await openProductRoute(page, '/tasks');
    await expect(page.getByTestId('product-shell')).not.toHaveAttribute('data-state', 'loading');
    const receipt = JSON.parse(await readFile(`/tmp/geneway-runs/${runId}/process-boundaries/control-plane.json`, 'utf8')) as {
      pid: number; procStartTicks: string; generation: number;
    };
    const stopped = await supervisor(controlPlaneSupervisorPort, '/test/kill-control-plane', { ...receipt, restart: false });
    expect(stopped.status).toBe(202);
    await page.goto('/tasks');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'offline');
    await expect(page.getByTestId('route-offline')).toContainText('Control Plane 当前离线');
    await page.screenshot({ path: testInfo.outputPath('control-plane-offline.png'), fullPage: true });
    const resumed = await supervisor(controlPlaneSupervisorPort, '/test/resume-control-plane', {});
    expect(resumed.status).toBe(202);
    await waitForSupervisor(controlPlaneSupervisorPort);
    await page.getByRole('button', { name: '重新加载' }).click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'empty');
    await page.screenshot({ path: testInfo.outputPath('control-plane-recovered.png'), fullPage: true });
  });

  test('exception Worker 在步骤 checkpoint 被 kill 后 reclaim，同任务只发布一个结果', async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const task = await exceptionTask(request, 'capacity_progress_lag', 'gate02b3-reclaim');
    const initialWorker = await readWorkerReceipt();
    const firstHook = await armHook(task.taskId, 'impact_analysis');
    await openProductRoute(page, `/tasks/${task.taskId}`);
    await approveAndExecute(request, task, 'gate02b3-reclaim');
    const triggered = await waitForHook(firstHook);
    expect(triggered.payload).toMatchObject({ taskId: task.taskId, workerInstanceId: initialWorker.workerInstanceId, stepId: 'impact_analysis' });
    await page.reload();
    await expect(page.getByTestId('task-detail')).toBeVisible();

    const killed = await supervisor(workerSupervisorPort, '/test/kill-worker', initialWorker);
    expect(killed.status, await killed.text()).toBe(202);
    const completionBlock = await armHook(task.taskId, 'report_publish');
    await expect.poll(async () => (await readWorkerReceipt()).workerInstanceId, { timeout: 15_000 }).not.toBe(initialWorker.workerInstanceId);
    const replacementWorker = await readWorkerReceipt();
    const secondTriggered = await waitForHook(completionBlock);
    expect(secondTriggered.payload.workerInstanceId).toBe(replacementWorker.workerInstanceId);
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'recovering', { timeout: 15_000 });
    await expect(page.getByTestId('route-recovering')).toContainText('同一任务');
    await page.screenshot({ path: testInfo.outputPath('worker-recovering.png'), fullPage: true });
    await releaseHook(secondTriggered);
    await expect.poll(async () => (await (await request.get(`/api/business-tasks/${task.taskId}`)).json() as { status: string }).status,
      { timeout: 45_000 }).toBe('completed');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expect(page.getByTestId('task-detail').locator('.status')).toHaveText('completed');
    await page.screenshot({ path: testInfo.outputPath('worker-recovered.png'), fullPage: true });

    const result = await pool.query<{
      attempt_count: string; superseded: string; completed: string; candidates: string; claims: string; artifacts: string; reclaimed: string;
    }>(`SELECT
      (SELECT count(*)::text FROM execution_attempts WHERE business_task_id=$1) attempt_count,
      (SELECT count(*)::text FROM execution_attempts WHERE business_task_id=$1 AND status='superseded') superseded,
      (SELECT count(*)::text FROM execution_attempts WHERE business_task_id=$1 AND status='completed') completed,
      (SELECT count(*)::text FROM attempt_output_candidates WHERE business_task_id=$1) candidates,
      (SELECT count(*)::text FROM claims WHERE business_task_id=$1 AND status='published') claims,
      (SELECT count(*)::text FROM artifacts WHERE business_task_id=$1 AND kind='simulation_report') artifacts,
      (SELECT count(*)::text FROM business_task_events WHERE business_task_id=$1 AND event_type='workflow.run_reclaimed') reclaimed`, [task.taskId]);
    expect(result.rows[0]).toEqual({ attempt_count: '2', superseded: '1', completed: '1', candidates: '1', claims: '1', artifacts: '1', reclaimed: '1' });
  });

  test('运行中 exception 任务在确定性步骤阻塞时取消，SSE 重放保持终态且无结果', async ({ page, request }) => {
    const task = await exceptionTask(request, 'equipment_alarm', 'gate02b3-cancel');
    const hook = await armHook(task.taskId, 'deterministic_baseline');
    await approveAndExecute(request, task, 'gate02b3-cancel');
    const triggered = await waitForHook(hook);
    const before = await (await request.get(`/api/business-tasks/${task.taskId}`)).json() as { eventWatermark: number };
    const canceled = await post(request, `/api/business-tasks/${task.taskId}/cancel`, 'gate02b3-cancel-request');
    expect(canceled.status(), await canceled.text()).toBe(200);
    await releaseHook(triggered);

    const replay = await request.get(`/api/business-tasks/${task.taskId}/events?after=${String(before.eventWatermark)}`, {
      headers: { accept: 'text/event-stream' },
    });
    const events = (await replay.text()).split('\n').filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { id: string; cursor: number; eventType: string });
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.every((event) => event.cursor > before.eventWatermark)).toBe(true);
    expect(events.some((event) => event.eventType === 'business_task.canceled')).toBe(true);
    await openProductRoute(page, `/tasks/${task.taskId}`);
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'canceled');
    await expect(page.getByTestId('task-result')).toContainText('用户已取消模拟任务');
    await expect(page.getByRole('button', { name: /恢复/u })).toHaveCount(0);
    const counts = await pool.query<{ claims: string; artifacts: string; candidates: string }>(`SELECT
      (SELECT count(*)::text FROM claims WHERE business_task_id=$1) claims,
      (SELECT count(*)::text FROM artifacts WHERE business_task_id=$1) artifacts,
      (SELECT count(*)::text FROM attempt_output_candidates WHERE business_task_id=$1) candidates`, [task.taskId]);
    expect(counts.rows[0]).toEqual({ claims: '0', artifacts: '0', candidates: '0' });
  });
});
