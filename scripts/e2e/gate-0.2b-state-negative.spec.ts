import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { hashCanonical } from '../../packages/workflow/src/index.js';
import pg from 'pg';

const { Pool } = pg;
const executeFile = promisify(execFile);
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
if (databaseUrl === undefined) throw new Error('Gate 0.2B.3 state oracle requires disposable Postgres');
const pool = new Pool({ connectionString: databaseUrl });
const webPort = process.env.GENEWAY_WEB_PORT;
if (webPort === undefined) throw new Error('Gate 0.2B.3 state oracle requires the served Web port');
const origin = `http://localhost:${webPort}`;
let stateTaskId = '';
let stateWorkflowId = '';
let stateConversationId = '';

async function seed(): Promise<void> {
  await pool.query(`INSERT INTO control_plane_database_metadata (singleton,is_non_production,environment_name)
    VALUES (true,true,'gate02b3-negative') ON CONFLICT (singleton) DO UPDATE SET is_non_production=true`);
  await pool.query(`INSERT INTO resource_scopes (tenant_id,user_id,resource_scope)
    VALUES ('tenant_local','user_local','factory-01/workshop-machining/line-02') ON CONFLICT DO NOTHING`);
  await executeFile(process.execPath, ['--import', 'tsx', 'scripts/seed-gate0.2b-fixtures.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, GENEWAY_TENANT_ID: 'tenant_local' },
  });
}

async function mainExceptionId(): Promise<string> {
  const row = await pool.query<{ id: string }>("SELECT id FROM business_exceptions WHERE exception_type='capacity_progress_lag'");
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error('main exception fixture is missing');
  return id;
}

async function post(request: APIRequestContext, url: string, key: string, data?: unknown) {
  return request.post(url, { headers: { origin, 'idempotency-key': key }, ...(data === undefined ? {} : { data }) });
}

async function openFastChat(page: Page): Promise<void> {
  await expect.poll(async () => {
    const response = await page.goto('/conversations/new');
    return response?.status() === 200 && await page.getByTestId('geneway-fast-chat').count() === 1;
  }, { timeout: 20_000 }).toBe(true);
}

async function expectLockedLoading(page: Page, table: string, route: string): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query(`LOCK ${table} IN ACCESS EXCLUSIVE MODE`);
    await page.goto(route);
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'loading');
    await lock.query('COMMIT');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'empty');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
}

async function expectNotFoundEquivalent(known: Awaited<ReturnType<APIRequestContext['get']>>, missing: Awaited<ReturnType<APIRequestContext['get']>>) {
  expect(known.status()).toBe(404);
  expect(missing.status()).toBe(404);
  expect(await known.text()).toBe(await missing.text());
  for (const name of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) {
    expect(known.headers()[name], name).toBe(missing.headers()[name]);
  }
}

test.describe.serial('Gate 0.2B.3 bounded route states', () => {
  test.afterAll(async () => pool.end());

  test('empty、loading、filtered-empty 与 forbidden 都来自真实 Control Plane', async ({ page, request }) => {
    await openFastChat(page);
    await expect(page.getByTestId('geneway-fast-chat')).toBeVisible();
    await expect(page.getByLabel('给小纬发消息')).toBeEnabled();
    await expect(page.getByTestId('artifact-upload-input')).toHaveCount(0);
    await page.goto('/exceptions');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'empty');
    await page.goto('/tasks');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'empty');
    await page.goto('/workflows');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'empty');

    await expectLockedLoading(page, 'business_exceptions', '/exceptions');
    await expectLockedLoading(page, 'business_tasks', '/tasks');
    await expectLockedLoading(page, 'workflow_versions', '/workflows');
    await seed();
    const conversation = await post(request, '/api/conversations', 'gate02b3-state-conversation');
    const conversationId = (await conversation.json() as { id: string }).id;
    const created = await post(request, '/api/business-tasks', 'gate02b3-state-task', {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1' },
      expertTarget: { mode: 'auto' },
    });
    const ids = await created.json() as { taskId: string; workflowVersionId: string };
    stateTaskId = ids.taskId;
    stateWorkflowId = ids.workflowVersionId;
    const oracleConversation = await post(request, '/api/conversations', 'gate02b3-state-oracle-conversation');
    stateConversationId = (await oracleConversation.json() as { id: string }).id;

    await page.goto('/exceptions?severity=critical');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'filtered-empty');
    await expect(page.getByTestId('exception-empty')).toContainText('当前筛选没有匹配异常');
    await page.getByRole('link', { name: '清除筛选' }).click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');
    await page.goto('/tasks?status=canceled');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'filtered-empty');
    await expect(page.getByTestId('route-filtered-empty')).toContainText('当前筛选没有匹配任务');
    await page.getByRole('link', { name: '清除筛选' }).click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');
    await page.goto('/workflows?capabilityVersionId=cap_operations_exception_assist_v1_shadow_1');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'filtered-empty');
    await expect(page.getByTestId('route-filtered-empty')).toContainText('当前筛选没有匹配 Workflow');
    await page.getByRole('link', { name: '清除筛选' }).click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');
    await page.goto('/workflows?capabilityVersionId=');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');

    await page.goto('/exceptions?resourceScope=factory-forbidden');
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'forbidden');
    await expect(page.getByTestId('route-forbidden')).not.toContainText(/tenant|owner|count/iu);

    await pool.query("DELETE FROM roles WHERE tenant_id='tenant_local' AND user_id='user_local' AND role='solution_reviewer'");
    try {
      for (const route of ['/api/business-exceptions', '/api/business-tasks']) {
        const denied = await request.get(route);
        expect(denied.status()).toBe(403);
        expect(await denied.text()).not.toMatch(/nextCursor|asOf|queryVersion|count/iu);
      }
      for (const route of ['/exceptions', '/tasks']) {
        await page.goto(route);
        await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'forbidden');
        await expect(page.getByTestId('route-forbidden')).not.toContainText(/nextCursor|asOf|queryVersion|count|tenant|owner/iu);
      }
    } finally {
      await pool.query("INSERT INTO roles (tenant_id,user_id,role) VALUES ('tenant_local','user_local','solution_reviewer') ON CONFLICT DO NOTHING");
    }
  });

  test('存在但无权与不存在详情保持 404 oracle 等价', async ({ request, page }) => {
    const exceptionId = await mainExceptionId();
    await pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ('tenant_local','user_gate02b3_other','Gate 0.2B.3 other user') ON CONFLICT DO NOTHING");

    await page.goto(`/exceptions/${encodeURIComponent(exceptionId)}`);
    await expect(page.getByTestId('exception-detail')).toBeVisible();
    const exceptionScope = await page.getByTestId('exception-detail').locator('.exception-hero p').innerText();
    const exceptionSourceHash = await page.getByTestId('exception-source-evidence').locator('code').first().innerText();
    await pool.query(`DELETE FROM resource_scopes WHERE tenant_id='tenant_local' AND user_id='user_local'
      AND resource_scope='factory-01/workshop-machining/line-02'`);
    try {
      await page.getByTestId('exception-acknowledge').click();
      await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'not-found');
      await expect(page.getByTestId('exception-detail')).toHaveCount(0);
      await expect(page.getByTestId('exception-source-evidence')).toHaveCount(0);
      await expect(page.locator('.product-inspector .facts')).toHaveCount(0);
      const failClosedHtml = await page.locator('body').innerHTML();
      expect(failClosedHtml).not.toContain(exceptionId);
      expect(failClosedHtml).not.toContain(exceptionScope);
      expect(failClosedHtml).not.toContain(exceptionSourceHash);
    } finally {
      await pool.query(`INSERT INTO resource_scopes (tenant_id,user_id,resource_scope)
        VALUES ('tenant_local','user_local','factory-01/workshop-machining/line-02') ON CONFLICT DO NOTHING`);
    }

    const taskAuthority = await pool.query<{ status: string }>(
      'SELECT status FROM business_tasks WHERE tenant_id=$1 AND id=$2',
      ['tenant_local', stateTaskId],
    );
    const taskAuthorityRow = taskAuthority.rows[0];
    if (taskAuthorityRow === undefined) throw new Error('state task authority fixture is missing');
    await pool.query("UPDATE business_tasks SET status='queued' WHERE tenant_id=$1 AND id=$2", ['tenant_local', stateTaskId]);
    await page.goto(`/tasks/${encodeURIComponent(stateTaskId)}`);
    await expect(page.getByTestId('task-detail')).toBeVisible();
    const taskWorkflowId = await page.getByTestId('task-workflow-id').innerText();
    const taskWorkflowHash = await page.getByTestId('task-workflow-hash').innerText();
    await pool.query("DELETE FROM roles WHERE tenant_id='tenant_local' AND user_id='user_local' AND role='solution_reviewer'");
    try {
      await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'not-found', { timeout: 10_000 });
      await expect(page.getByTestId('task-detail')).toHaveCount(0);
      await expect(page.locator('[data-evidence-id], [data-artifact-id]')).toHaveCount(0);
      await expect(page.locator('.product-inspector .facts')).toHaveCount(0);
      const failClosedHtml = await page.locator('body').innerHTML();
      expect(failClosedHtml).not.toContain(stateTaskId);
      expect(failClosedHtml).not.toContain(taskWorkflowId);
      expect(failClosedHtml).not.toContain(taskWorkflowHash);
    } finally {
      await pool.query("INSERT INTO roles (tenant_id,user_id,role) VALUES ('tenant_local','user_local','solution_reviewer') ON CONFLICT DO NOTHING");
      await pool.query('UPDATE business_tasks SET status=$1 WHERE tenant_id=$2 AND id=$3', [taskAuthorityRow.status, 'tenant_local', stateTaskId]);
    }

    await pool.query("UPDATE conversations SET user_id='user_gate02b3_other' WHERE tenant_id='tenant_local' AND id=$1", [stateConversationId]);
    await pool.query("DELETE FROM roles WHERE tenant_id='tenant_local' AND user_id='user_local' AND role='solution_reviewer'");
    await pool.query(`DELETE FROM resource_scopes WHERE tenant_id='tenant_local' AND user_id='user_local'
      AND resource_scope='factory-01/workshop-machining/line-02'`);
    try {
      await expectNotFoundEquivalent(
        await request.get(`/api/conversations/${encodeURIComponent(stateConversationId)}`),
        await request.get('/api/conversations/conversation_missing_gate02b3'),
      );
      await expectNotFoundEquivalent(
        await request.get(`/api/business-exceptions/${encodeURIComponent(exceptionId)}`),
        await request.get('/api/business-exceptions/exception_missing_gate02b3'),
      );
      await expectNotFoundEquivalent(
        await request.get(`/api/business-tasks/${encodeURIComponent(stateTaskId)}`),
        await request.get('/api/business-tasks/task_missing_gate02b3'),
      );
      await expectNotFoundEquivalent(
        await request.get(`/api/workflow-versions/${encodeURIComponent(stateWorkflowId)}`),
        await request.get('/api/workflow-versions/workflow_missing_gate02b3'),
      );
      for (const route of [
        `/conversations/${encodeURIComponent(stateConversationId)}`,
        `/exceptions/${encodeURIComponent(exceptionId)}`,
        `/tasks/${encodeURIComponent(stateTaskId)}`,
        `/tasks/${encodeURIComponent(stateTaskId)}/workflow`,
        `/workflows/${encodeURIComponent(stateWorkflowId)}`,
      ]) {
        await page.goto(route);
        await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'not-found');
        await expect(page.getByTestId('route-not-found')).not.toContainText(new RegExp(`${exceptionId}|${stateConversationId}|${stateTaskId}|${stateWorkflowId}|owner|Evidence`, 'iu'));
      }
    } finally {
      await pool.query("UPDATE conversations SET user_id='user_local' WHERE tenant_id='tenant_local' AND id=$1", [stateConversationId]);
      await pool.query("INSERT INTO roles (tenant_id,user_id,role) VALUES ('tenant_local','user_local','solution_reviewer') ON CONFLICT DO NOTHING");
      await pool.query(`INSERT INTO resource_scopes (tenant_id,user_id,resource_scope)
        VALUES ('tenant_local','user_local','factory-01/workshop-machining/line-02') ON CONFLICT DO NOTHING`);
    }
  });

  test('旧 aggregateVersion 与 singleton 变化投影 stale / binding-conflict', async ({ page, request }) => {
    const exceptionId = await mainExceptionId();
    await page.goto(`/exceptions/${encodeURIComponent(exceptionId)}`);
    await pool.query('UPDATE business_exceptions SET aggregate_version=aggregate_version+1 WHERE id=$1', [exceptionId]);
    await page.getByTestId('exception-acknowledge').click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'stale');

    const refreshed = await request.get(`/api/business-exceptions/${exceptionId}`);
    const refreshedDetail = await refreshed.json() as { aggregateVersion: number };
    const acknowledged = await post(request, `/api/business-exceptions/${exceptionId}/acknowledge`, 'gate02b3-stale-server-ack', {
      aggregateVersion: refreshedDetail.aggregateVersion,
    });
    expect(acknowledged.status()).toBe(200);
    const current = await acknowledged.json() as { aggregateVersion: number };
    await page.reload();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');
    const binding = await post(request, `/api/business-exceptions/${exceptionId}/analysis-task`, 'gate02b3-binding-auto', {
      aggregateVersion: current.aggregateVersion,
      requestedExpertTarget: { mode: 'auto' },
      idempotencyKey: 'gate02b3-binding-auto',
    });
    expect(binding.status(), await binding.text()).toBe(201);
    const boundTaskId = (await binding.json() as { taskId: string }).taskId;
    await page.getByLabel('异常专家路线').selectOption('team');
    await page.getByTestId('exception-request-analysis').click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'binding-conflict');
    await expect(page.getByTestId('route-binding-conflict')).not.toContainText(boundTaskId);
    await page.getByRole('button', { name: '重新加载' }).click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('exception-request-analysis')).toBeDisabled();
    await expect(page.getByTestId('exception-request-analysis')).toContainText('已绑定分析任务');
  });

  test('旧 ApprovalVersion/subjectDigest 不可执行且页面进入 approval-stale', async ({ page, request }) => {
    const conversation = await post(request, '/api/conversations', 'gate02b3-approval-conversation');
    const conversationId = (await conversation.json() as { id: string }).id;
    const created = await post(request, '/api/business-tasks', 'gate02b3-approval-task', {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1' },
      expertTarget: { mode: 'auto' },
    });
    const ids = await created.json() as { taskId: string; approvalId: string };
    expect((await post(request, `/api/approvals/${ids.approvalId}/decisions`, 'gate02b3-approval-v1', { decision: 'approved' })).status()).toBe(200);
    await page.goto(`/tasks/${ids.taskId}/workflow`);
    await expect(page.getByTestId('task-workflow')).toBeVisible();
    const v2Subject = await pool.query<{ subject: Readonly<Record<string, unknown>>; subject_digest: string }>(
      'SELECT subject,subject_digest FROM approval_versions WHERE id=$1', [ids.approvalId],
    );
    const v2SubjectRow = v2Subject.rows[0];
    if (v2SubjectRow === undefined) throw new Error('Approval v1 subject is missing');
    const currentBudget = v2SubjectRow.subject.budget;
    if (typeof currentBudget !== 'object' || currentBudget === null || Array.isArray(currentBudget)) throw new Error('Approval v1 budget is invalid');
    const nextBudget = { ...currentBudget, maxRuntimeMs: 60_000 };
    const v2SubjectValue = { ...v2SubjectRow.subject, budget: nextBudget };
    const v2SubjectDigest = hashCanonical(v2SubjectValue);
    expect(v2SubjectDigest).not.toBe(v2SubjectRow.subject_digest);
    await pool.query(`INSERT INTO approval_versions
      (tenant_id,id,business_task_id,version,subject,subject_digest,status,requester_id,approver_policy_version,expires_at,decision_by,decision_at)
      SELECT tenant_id,'approval_gate02b3_v2',business_task_id,2,$2,$3,'pending',requester_id,
        approver_policy_version,now()+interval '15 minutes',null,null
      FROM approval_versions WHERE id=$1`, [ids.approvalId, v2SubjectValue, v2SubjectDigest]);
    await pool.query("UPDATE business_tasks SET status='awaiting_approval',budget=$2 WHERE id=$1", [ids.taskId, nextBudget]);
    await page.getByTestId('task-workflow-execute').click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'approval-stale');
    expect((await pool.query("SELECT 1 FROM business_task_events WHERE business_task_id=$1 AND event_type='workflow.execute.requested'", [ids.taskId])).rowCount).toBe(0);
    const currentPending = await post(request, `/api/business-tasks/${ids.taskId}/execute`, 'gate02b3-approval-v2-pending', {
      expectedApprovalVersion: 2,
      expectedApprovalSubjectDigest: v2SubjectDigest,
    });
    expect(currentPending.status()).toBe(409);
    expect(await currentPending.json()).toMatchObject({ error: { code: 'APPROVAL_REQUIRED' } });
    await page.getByRole('button', { name: '重新加载' }).click();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('workflow-approval-version')).toHaveText('2');
    await expect(page.getByTestId('workflow-approval-digest')).toHaveText(v2SubjectDigest);
    await expect(page.getByTestId('task-workflow-execute')).toHaveCount(0);
  });

  test('negative-only 非公开事件产生可识别 5xx，清理后同一路由恢复', async ({ page, request }) => {
    const conversation = await post(request, '/api/conversations', 'gate02b3-5xx-conversation');
    const conversationId = (await conversation.json() as { id: string }).id;
    const created = await post(request, '/api/business-tasks', 'gate02b3-5xx-task', {
      conversationId,
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1' },
      expertTarget: { mode: 'auto' },
    });
    const taskId = (await created.json() as { taskId: string }).taskId;
    await pool.query("UPDATE business_tasks SET status='queued' WHERE id=$1", [taskId]);
    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByTestId('task-detail')).toBeVisible();
    await pool.query(`INSERT INTO business_task_events
      (tenant_id,id,business_task_id,sequence,event_type,aggregate_version,correlation_id,payload,simulation,runtime_mode,business_decision_allowed)
      SELECT tenant_id,'event_gate02b3_unsafe',id,
        (SELECT coalesce(max(sequence),0)+1 FROM business_task_events WHERE business_task_id=$1),
        'negative_only.unsupported',aggregate_version+1,id,'{}'::jsonb,true,'fake',false
      FROM business_tasks WHERE id=$1`, [taskId]);
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'server-error', { timeout: 10_000 });
    await expect(page.getByTestId('route-server-error')).toContainText('EVENT_STREAM_FAILED: Internal Server Error');
    await expect(page.getByTestId('route-server-error')).not.toContainText('negative_only.unsupported');
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query('ALTER TABLE business_task_events DISABLE TRIGGER business_task_events_append_only');
      await cleanup.query("DELETE FROM business_task_events WHERE id='event_gate02b3_unsafe'");
      await cleanup.query('ALTER TABLE business_task_events ENABLE TRIGGER business_task_events_append_only');
      await cleanup.query('COMMIT');
    } catch (error) {
      await cleanup.query('ROLLBACK');
      await cleanup.query('ALTER TABLE business_task_events ENABLE TRIGGER business_task_events_append_only');
      throw error;
    } finally {
      cleanup.release();
    }
    await page.reload();
    await expect(page.getByTestId('product-shell')).toHaveAttribute('data-state', 'ready');
  });
});
