import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const runId = process.env.GENEWAY_RUN_ID;
if (databaseUrl === undefined || runId === undefined) {
  throw new Error('Gate 0.2B route test requires disposable Postgres and process receipts');
}

const sourcePath = path.resolve(process.cwd(), 'scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt');

type WorkerReceipt = Readonly<{
  role: string;
  phase: string;
  ready: boolean;
  workerInstanceId: string;
}>;

async function openServedRoute(page: Page, route: string, readyTestId: string): Promise<void> {
  const response = await page.goto(route);
  expect(response?.status(), route).toBe(200);
  await expect(page.getByTestId(readyTestId)).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u'));
  await expect(page.getByTestId(readyTestId)).toBeVisible();
}

test('真实任务可从六条 served 路由恢复，并与 API、Postgres 和 Worker 保持同一关联', async ({ page, request }) => {
  test.setTimeout(60_000);
  const worker = JSON.parse(await readFile(`/tmp/geneway-runs/${runId}/process-boundaries/worker.json`, 'utf8')) as WorkerReceipt;
  expect(worker).toMatchObject({ role: 'worker', phase: 'ready', ready: true });
  expect(worker.workerInstanceId).toMatch(/^e2e-worker-/u);

  const sourceBytes = await readFile(sourcePath);
  await page.goto('/conversations/new?capability=solution.analysis.v1');
  await page.getByTestId('artifact-upload-input').setInputFiles({
    name: 'solution-analysis-demo-v2.txt', mimeType: 'text/plain', buffer: sourceBytes,
  });
  const sourceCard = page.getByTestId('artifact-card').filter({ hasText: 'solution-analysis-demo-v2.txt' });
  await expect(sourceCard.getByTestId('artifact-eligibility')).toContainText('可用于模拟分析');
  await sourceCard.getByRole('button', { name: '选择用于分析' }).click();
  await page.getByLabel('专家路线').selectOption('team.solution.core');
  await page.getByLabel('给小纬发消息').fill('请小纬组织专家团完成这份材料的简单方案分析');
  await page.getByRole('button', { name: '发送' }).click();

  const taskCard = page.getByTestId('task-card');
  const taskId = await taskCard.getAttribute('data-task-id');
  const workflowId = await taskCard.getAttribute('data-workflow-id');
  const workflowHash = await taskCard.getAttribute('data-workflow-hash');
  expect(taskId).toBeTruthy();
  expect(workflowId).toBeTruthy();
  expect(workflowHash).toMatch(/^[a-f0-9]{64}$/u);
  await page.getByRole('button', { name: '关闭' }).click();
  await openServedRoute(page, `/tasks/${encodeURIComponent(taskId ?? '')}`, 'task-detail');
  await page.getByTestId('task-approve-execute').click();
  await expect.poll(async () => {
    const response = await request.get(`/api/business-tasks/${taskId ?? ''}`);
    return (await response.json() as { status?: string }).status;
  }, { timeout: 20_000 }).toBe('completed');
  await page.reload();
  await expect(page.getByTestId('task-result')).toBeVisible();

  const taskResponse = await request.get(`/api/business-tasks/${taskId ?? ''}`);
  expect(taskResponse.ok()).toBe(true);
  const task = await taskResponse.json() as {
    id: string;
    conversationId: string;
    status: string;
    workflowVersion: { id: string; hash: string };
    approval: { id: string; version: number; status: string; subjectDigest: string };
    expertTarget: { mode: string; teamId?: string };
    steps: readonly { id: string; status: string }[];
    evidence: readonly { id: string; excerptSha256: string }[];
    artifacts: readonly { id: string; kind: string; contentSha256: string }[];
    eventWatermark: number;
  };
  expect(task).toMatchObject({
    id: taskId, status: 'completed', workflowVersion: { id: workflowId, hash: workflowHash },
    approval: { version: 1, status: 'approved' }, expertTarget: { mode: 'team', teamId: 'team.solution.core' },
  });
  expect(task.steps).toHaveLength(7);
  expect(task.steps.every((step) => step.status === 'completed')).toBe(true);
  expect(task.evidence).toHaveLength(1);
  const report = task.artifacts.find((artifact) => artifact.kind === 'simulation_report');
  expect(report).toBeDefined();

  const approvalResponse = await request.get(`/api/approvals/${task.approval.id}`);
  expect(await approvalResponse.json()).toEqual({
    id: task.approval.id,
    businessTaskId: task.id,
    version: task.approval.version,
    status: task.approval.status,
    subjectDigest: task.approval.subjectDigest,
  });

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const correlation = await pool.query<{
      task_id: string;
      workflow_version_id: string;
      workflow_hash: string;
      approval_id: string;
      subject_digest: string;
      worker_instance_id: string;
      attempt_status: string;
      evidence_id: string;
      report_id: string;
      report_hash: string;
    }>(`SELECT task.id task_id,task.workflow_version_id,task.workflow_hash,
      approval.id approval_id,approval.subject_digest,
      attempt.worker_instance_id,attempt.status attempt_status,
      evidence.id evidence_id,report.id report_id,report.content_sha256 report_hash
      FROM business_tasks task
      JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
      JOIN execution_attempts attempt ON attempt.tenant_id=task.tenant_id AND attempt.id=task.current_execution_attempt_id
      JOIN evidence_items evidence ON evidence.tenant_id=task.tenant_id AND evidence.business_task_id=task.id
      JOIN artifacts report ON report.tenant_id=task.tenant_id AND report.business_task_id=task.id AND report.kind='simulation_report'
      WHERE task.tenant_id='tenant_local' AND task.id=$1`, [task.id]);
    expect(correlation.rows).toEqual([{
      task_id: task.id,
      workflow_version_id: task.workflowVersion.id,
      workflow_hash: task.workflowVersion.hash,
      approval_id: task.approval.id,
      subject_digest: task.approval.subjectDigest,
      worker_instance_id: worker.workerInstanceId,
      attempt_status: 'completed',
      evidence_id: task.evidence[0]?.id,
      report_id: report?.id,
      report_hash: report?.contentSha256,
    }]);
  } finally {
    await pool.end();
  }

  await Promise.all(Array.from({ length: 25 }, async (_, index) => {
    const suffix = String(index).padStart(2, '0');
    const conversationResponse = await request.post('/api/conversations', {
      headers: { 'idempotency-key': `gate02b-pagination-conversation-${suffix}` },
    });
    expect(conversationResponse.status()).toBe(201);
    const conversation = await conversationResponse.json() as { id: string };
    const response = await request.post('/api/business-tasks', {
      headers: { 'content-type': 'application/json', 'idempotency-key': `gate02b-pagination-task-${suffix}` },
      data: {
        conversationId: conversation.id,
        capabilityId: 'solution.analysis.v1',
        inputRef: { kind: 'fixture', fixtureRef: 'fixture:solution-analysis:v1' },
        expertTarget: { mode: 'auto' },
      },
    });
    expect(response.status()).toBe(201);
  }));

  await page.evaluate(() => localStorage.clear());

  await openServedRoute(page, '/tasks', 'task-table');
  await expect(page.getByTestId('next-page')).toBeVisible();
  await page.getByTestId('next-page').click();
  await expect
    .poll(() => {
      const currentUrl = new URL(page.url());
      return (
        currentUrl.pathname === '/tasks' &&
        Boolean(currentUrl.searchParams.get('cursor')) &&
        currentUrl.searchParams.get('sort') === 'updatedAt' &&
        currentUrl.searchParams.get('direction') === 'desc' &&
        currentUrl.searchParams.get('limit') === '25'
      );
    })
    .toBe(true);
  await expect(page.getByTestId('task-table')).toBeVisible();
  const taskRow = page.locator(`tr[data-task-id="${task.id}"]`);
  await expect(taskRow).toHaveAttribute('data-workflow-id', task.workflowVersion.id);
  await expect(taskRow).toHaveAttribute('data-workflow-hash', task.workflowVersion.hash);
  await expect(taskRow).toContainText('completed');

  await openServedRoute(page, `/tasks/${encodeURIComponent(task.id)}`, 'task-detail');
  await expect(page.getByTestId('task-detail')).toHaveAttribute('data-workflow-id', task.workflowVersion.id);
  await expect(page.getByTestId('task-workflow-hash')).toHaveText(task.workflowVersion.hash);
  await expect(page.getByTestId('approval-subject-digest')).toHaveText(task.approval.subjectDigest);
  await expect(page.locator(`[data-evidence-id="${task.evidence[0]?.id ?? ''}"]`)).toBeVisible();
  await expect(page.locator(`[data-artifact-id="${report?.id ?? ''}"]`)).toHaveAttribute('data-content-sha256', report?.contentSha256 ?? '');
  await expect(page.getByTestId('expert-target')).toContainText('专家团');

  await openServedRoute(page, `/tasks/${encodeURIComponent(task.id)}/workflow`, 'task-workflow');
  await expect(page.getByTestId('workflow-graph')).toHaveAttribute('data-workflow-id', task.workflowVersion.id);
  await expect(page.getByTestId('workflow-hash')).toHaveText(task.workflowVersion.hash);
  await expect(page.getByTestId('workflow-approval-digest')).toHaveText(task.approval.subjectDigest);
  await expect(page.getByTestId('workflow-graph').locator('.react-flow__node')).toHaveCount(7);

  await openServedRoute(page, '/workflows', 'workflow-table');
  const workflowRow = page.locator(`tr[data-workflow-id="${task.workflowVersion.id}"]`);
  await expect(workflowRow).toHaveAttribute('data-workflow-hash', task.workflowVersion.hash);

  await openServedRoute(page, `/workflows/${encodeURIComponent(task.workflowVersion.id)}`, 'workflow-detail');
  await expect(page.getByTestId('workflow-detail')).toHaveAttribute('data-workflow-hash', task.workflowVersion.hash);
  await expect(page.getByTestId('workflow-version-id')).toHaveText(task.workflowVersion.id);
  await expect(page.getByTestId('workflow-version-hash')).toHaveText(task.workflowVersion.hash);
  await expect(page.getByTestId('workflow-graph').locator('.react-flow__node')).toHaveCount(7);

  await page.evaluate(() => localStorage.clear());
  await openServedRoute(page, `/conversations/${encodeURIComponent(task.conversationId)}`, 'task-card');
  await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', task.id);
  await expect(page.getByTestId('task-card')).toHaveAttribute('data-workflow-id', task.workflowVersion.id);
  await expect(page.getByTestId('task-card')).toHaveAttribute('data-workflow-hash', task.workflowVersion.hash);
  await expect(page.getByTestId('conversation-approval-digest')).toHaveText(task.approval.subjectDigest);
  await expect(page.locator(`[data-evidence-id="${task.evidence[0]?.id ?? ''}"]`)).toBeVisible();
  await expect(page.locator(`[data-artifact-id="${report?.id ?? ''}"]`)).toHaveAttribute('data-content-sha256', report?.contentSha256 ?? '');
  const authors = await page.locator('[data-author]').evaluateAll((elements) => [...new Set(elements.map((element) => element.getAttribute('data-author')))].sort());
  expect(authors).toEqual(['user', 'xiaowei']);
  await expect(page.locator('[data-author="expert"], [data-author="team"]')).toHaveCount(0);
});
