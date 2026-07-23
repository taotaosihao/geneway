import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const executeFile = promisify(execFile);
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const runId = process.env.GENEWAY_RUN_ID;
if (databaseUrl === undefined || runId === undefined) {
  throw new Error('Gate 0.2B exception flow requires disposable Postgres and process receipts');
}

type TaskProjection = Readonly<{
  id: string;
  conversationId: string;
  status: string;
  workflowVersion: Readonly<{ id: string; hash: string }>;
  approval: Readonly<{ id: string; version: number; status: string; subjectDigest: string }>;
  expertTarget: Readonly<{ mode: string; teamId?: string }>;
  steps: readonly Readonly<{ id: string; status: string }>[];
  evidence: readonly Readonly<{ id: string; source: Readonly<Record<string, unknown>> }>[];
  claims: readonly Readonly<{ id: string; status: string; evidenceRefId: string | null }>[];
  artifacts: readonly Readonly<{
    id: string; kind: string; contentSha256: string; downloadUrl: string;
  }>[];
}>;

async function runControlledSeed(): Promise<Readonly<{
  fixtures: readonly Readonly<{ id: string; sourceVersionId: string; created: boolean }>[];
}>> {
  const { stdout } = await executeFile(process.execPath, ['--import', 'tsx', 'scripts/seed-gate0.2b-fixtures.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      GENEWAY_TENANT_ID: 'tenant_local',
    },
  });
  return JSON.parse(stdout) as ReturnType<typeof runControlledSeed> extends Promise<infer T> ? T : never;
}

async function openServedRoute(page: Page, route: string, readyTestId: string): Promise<void> {
  const response = await page.goto(route);
  expect(response?.status(), route).toBe(200);
  await expect(page.getByTestId(readyTestId)).toBeVisible();
}

async function readTask(request: APIRequestContext, taskId: string): Promise<TaskProjection> {
  const response = await request.get(`/api/business-tasks/${encodeURIComponent(taskId)}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<TaskProjection>;
}

test('真实异常纵切关联 served UI、API、Postgres、Worker 与 S3 Artifact', async ({ page, request }) => {
  test.setTimeout(90_000);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`INSERT INTO control_plane_database_metadata (singleton,is_non_production,environment_name)
      VALUES (true,true,'playwright-disposable')
      ON CONFLICT (singleton) DO UPDATE SET is_non_production=true,environment_name=excluded.environment_name,updated_at=now()`);
    await pool.query(`INSERT INTO resource_scopes (tenant_id,user_id,resource_scope)
      VALUES ('tenant_local','user_local','factory-01/workshop-machining/line-02')
      ON CONFLICT DO NOTHING`);

    const firstSeed = await runControlledSeed();
    expect(firstSeed.fixtures).toHaveLength(2);
    expect(firstSeed.fixtures.every((fixture) => fixture.created)).toBe(true);
    const replaySeed = await runControlledSeed();
    expect(replaySeed.fixtures).toHaveLength(2);
    expect(replaySeed.fixtures.every((fixture) => !fixture.created)).toBe(true);

    const seedAuthority = await pool.query<{
      exception_count: string; source_count: string; detected_count: string;
      seed_audit_count: string; source_evidence_count: string; binding_count: string;
    }>(`SELECT
      (SELECT count(*)::text FROM business_exceptions WHERE tenant_id='tenant_local') exception_count,
      (SELECT count(*)::text FROM business_exception_source_snapshots WHERE tenant_id='tenant_local') source_count,
      (SELECT count(*)::text FROM business_exception_events WHERE tenant_id='tenant_local' AND event_type='business_exception.detected') detected_count,
      (SELECT count(*)::text FROM audit_events WHERE tenant_id='tenant_local' AND event_type='business_exception.seeded') seed_audit_count,
      (SELECT count(*)::text FROM evidence_items WHERE tenant_id='tenant_local' AND source_kind='business_exception_snapshot') source_evidence_count,
      (SELECT count(*)::text FROM business_exception_analysis_bindings WHERE tenant_id='tenant_local') binding_count`);
    expect(seedAuthority.rows[0]).toEqual({
      exception_count: '2', source_count: '2', detected_count: '2', seed_audit_count: '2',
      source_evidence_count: '0', binding_count: '0',
    });

    await openServedRoute(page, '/exceptions', 'exception-table');
    await expect(page.getByLabel('模拟边界')).toContainText('固定、脱敏的模拟数据');
    await expect(page.getByTestId('exception-table').locator('tbody tr')).toHaveCount(2);
    await expect(page.getByTestId('exception-table').getByText('模拟', { exact: true })).toHaveCount(2);

    const mainRow = page.getByTestId('exception-table').locator('tbody tr').filter({ hasText: '二号机加工线工单进度落后' });
    const exceptionId = await mainRow.getAttribute('data-exception-id');
    expect(exceptionId).toBeTruthy();
    await mainRow.getByRole('link', { name: /二号机加工线工单进度落后/u }).click();
    await expect(page.getByTestId('exception-detail')).toHaveAttribute('data-exception-id', exceptionId ?? '');
    await expect(page.getByTestId('exception-source-evidence').locator('article')).toHaveCount(5);

    const detailResponse = await request.get(`/api/business-exceptions/${encodeURIComponent(exceptionId ?? '')}`);
    expect(detailResponse.ok()).toBe(true);
    const detail = await detailResponse.json() as {
      id: string; aggregateVersion: number; simulation: boolean; resourceScope: string;
      evidence: readonly { sourceVersionId: string; sourceSha256: string; jsonPointer: string; valueSha256: string }[];
    };
    expect(detail).toMatchObject({ id: exceptionId, aggregateVersion: 1, simulation: true });
    expect(new Set(detail.evidence.map((item) => item.sourceVersionId))).toEqual(new Set([firstSeed.fixtures[0]?.sourceVersionId]));
    expect(new Set(detail.evidence.map((item) => item.sourceSha256))).toEqual(new Set([
      '0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6',
    ]));

    await page.getByTestId('exception-acknowledge').click();
    await expect(page.getByText('已由我认领')).toBeVisible();
    await page.getByLabel('异常专家路线').selectOption('team');
    await page.getByTestId('exception-request-analysis').click();
    const binding = page.getByTestId('exception-analysis-binding');
    await expect(binding).toBeVisible();
    const taskId = await binding.getAttribute('data-task-id');
    const workflowId = await binding.getAttribute('data-workflow-id');
    const workflowHash = await binding.getAttribute('data-workflow-hash');
    const approvalSubjectDigest = await binding.getByTestId('exception-approval-subject-digest').textContent();
    expect(taskId).toBeTruthy();
    expect(workflowId).toBeTruthy();
    expect(workflowHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(approvalSubjectDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(approvalSubjectDigest).not.toBe(workflowHash);

    await binding.getByRole('link', { name: taskId ?? '' }).click();
    await expect(page.getByTestId('task-detail')).toHaveAttribute('data-task-id', taskId ?? '');
    await expect(page.getByTestId('task-workflow-hash')).toHaveText(workflowHash ?? '');
    await expect(page.getByTestId('approval-subject-digest')).toHaveText(approvalSubjectDigest ?? '');
    await expect(page.getByTestId('expert-target')).toContainText('team.operations.exception');
    await page.getByTestId('task-approve-execute').click();
    await expect.poll(async () => (await readTask(request, taskId ?? '')).status, { timeout: 30_000 }).toBe('completed');

    const task = await readTask(request, taskId ?? '');
    expect(task).toMatchObject({
      id: taskId,
      status: 'completed',
      workflowVersion: { id: workflowId, hash: workflowHash },
      approval: { version: 1, status: 'approved', subjectDigest: approvalSubjectDigest },
      expertTarget: { mode: 'team', teamId: 'team.operations.exception' },
    });
    expect(task.steps).toHaveLength(7);
    expect(task.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(task.evidence.length).toBeGreaterThan(0);
    expect(task.claims.some((claim) => claim.status === 'published' && claim.evidenceRefId !== null)).toBe(true);
    const report = task.artifacts.find((artifact) => artifact.kind === 'simulation_report');
    expect(report).toBeDefined();
    const download = await request.get(report?.downloadUrl ?? '/missing-report');
    expect(download.ok()).toBe(true);
    const reportBytes = await download.body();
    expect(createHash('sha256').update(reportBytes).digest('hex')).toBe(report?.contentSha256);
    expect(reportBytes.toString('utf8')).toContain('模拟');

    const correlation = await pool.query<{
      exception_id: string; source_version_id: string; source_sha256: string; task_id: string;
      conversation_id: string; workflow_version_id: string; workflow_hash: string; subject_digest: string;
      worker_instance_id: string; attempt_status: string; delivery_status: string; inbox_status: string;
      published_claims: string; evidence_count: string; lineage_count: string; report_id: string; report_hash: string;
    }>(`SELECT exception.id exception_id,snapshot.source_version_id,snapshot.canonical_sha256 source_sha256,
      binding.business_task_id task_id,binding.private_conversation_id conversation_id,
      task.workflow_version_id,task.workflow_hash,approval.subject_digest,
      attempt.worker_instance_id,attempt.status attempt_status,delivery.status delivery_status,inbox.status inbox_status,
      (SELECT count(*)::text FROM claims claim WHERE claim.tenant_id=task.tenant_id AND claim.business_task_id=task.id AND claim.status='published') published_claims,
      (SELECT count(*)::text FROM evidence_items evidence WHERE evidence.tenant_id=task.tenant_id AND evidence.business_task_id=task.id) evidence_count,
      (SELECT count(*)::text FROM lineage_records lineage WHERE lineage.tenant_id=task.tenant_id AND lineage.business_task_id=task.id) lineage_count,
      report.id report_id,report.content_sha256 report_hash
      FROM business_exceptions exception
      JOIN business_exception_source_snapshots snapshot ON snapshot.tenant_id=exception.tenant_id AND snapshot.business_exception_id=exception.id
      JOIN business_exception_analysis_bindings binding ON binding.tenant_id=snapshot.tenant_id AND binding.source_version_id=snapshot.source_version_id
      JOIN business_tasks task ON task.tenant_id=binding.tenant_id AND task.id=binding.business_task_id
      JOIN approval_versions approval ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
      JOIN execution_attempts attempt ON attempt.tenant_id=task.tenant_id AND attempt.id=task.current_execution_attempt_id
      JOIN outbox_deliveries delivery ON delivery.tenant_id=attempt.tenant_id AND delivery.execution_attempt_id=attempt.id
      JOIN inbox_events inbox ON inbox.tenant_id=delivery.tenant_id AND inbox.delivery_id=delivery.id
      JOIN artifacts report ON report.tenant_id=task.tenant_id AND report.business_task_id=task.id AND report.kind='simulation_report'
      WHERE exception.tenant_id='tenant_local' AND exception.id=$1`, [exceptionId]);
    expect(correlation.rows).toEqual([expect.objectContaining({
      exception_id: exceptionId,
      source_version_id: detail.evidence[0]?.sourceVersionId,
      source_sha256: detail.evidence[0]?.sourceSha256,
      task_id: task.id,
      conversation_id: task.conversationId,
      workflow_version_id: task.workflowVersion.id,
      workflow_hash: task.workflowVersion.hash,
      subject_digest: task.approval.subjectDigest,
      attempt_status: 'completed',
      delivery_status: 'completed',
      inbox_status: 'completed',
      report_id: report?.id,
      report_hash: report?.contentSha256,
    })]);
    expect(Number(correlation.rows[0]?.published_claims)).toBeGreaterThan(0);
    expect(Number(correlation.rows[0]?.evidence_count)).toBeGreaterThan(0);
    expect(Number(correlation.rows[0]?.lineage_count)).toBeGreaterThan(0);
    expect(correlation.rows[0]?.worker_instance_id).toMatch(/^e2e-worker-/u);

    await openServedRoute(page, `/tasks/${encodeURIComponent(task.id)}/workflow`, 'task-workflow');
    await expect(page.getByTestId('workflow-hash')).toHaveText(task.workflowVersion.hash);
    await expect(page.getByTestId('workflow-approval-digest')).toHaveText(task.approval.subjectDigest);
    await openServedRoute(page, `/workflows/${encodeURIComponent(task.workflowVersion.id)}`, 'workflow-detail');
    await expect(page.getByTestId('workflow-version-hash')).toHaveText(task.workflowVersion.hash);
    await openServedRoute(page, `/conversations/${encodeURIComponent(task.conversationId)}`, 'task-card');
    await expect(page.getByTestId('task-card')).toHaveAttribute('data-task-id', task.id);
    await expect(page.getByText('小纬已完成模拟异常分析。结果仅供演示，不能用于业务决策。')).toBeVisible();
    const authors = await page.locator('[data-author]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-author')));
    expect(authors.every((author) => author === 'user' || author === 'xiaowei')).toBe(true);
    await expect(page.locator('[data-author="expert"], [data-author="team"]')).toHaveCount(0);
  } finally {
    await pool.end();
  }
});
