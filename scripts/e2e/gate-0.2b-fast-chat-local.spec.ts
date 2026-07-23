import { expect, test } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
if (databaseUrl === undefined) throw new Error('Gate 0.2B local Fast Chat oracle requires disposable Postgres');
const pool = new Pool({ connectionString: databaseUrl });

type Counts = Readonly<{
  conversations: number;
  business_exceptions: number;
  business_tasks: number;
  approval_versions: number;
  workflow_versions: number;
  evidence_items: number;
  artifacts: number;
  model_invocations: number;
}>;

async function authorityCounts(): Promise<Counts> {
  const result = await pool.query<Counts>(`SELECT
    (SELECT count(*)::int FROM conversations) conversations,
    (SELECT count(*)::int FROM business_exceptions) business_exceptions,
    (SELECT count(*)::int FROM business_tasks) business_tasks,
    (SELECT count(*)::int FROM approval_versions) approval_versions,
    (SELECT count(*)::int FROM workflow_versions) workflow_versions,
    (SELECT count(*)::int FROM evidence_items) evidence_items,
    (SELECT count(*)::int FROM artifacts) artifacts,
    (SELECT count(*)::int FROM model_invocations) model_invocations`);
  const counts = result.rows[0];
  if (counts === undefined) throw new Error('Gate 0.2B local Fast Chat authority count is missing');
  return counts;
}

test.afterAll(async () => pool.end());

test('默认 Fast Chat 无需材料且不创建 Gate 0.2B 业务对象', async ({ page }) => {
  const before = await authorityCounts();
  expect(before).toEqual({
    conversations: 0,
    business_exceptions: 0,
    business_tasks: 0,
    approval_versions: 0,
    workflow_versions: 0,
    evidence_items: 0,
    artifacts: 0,
    model_invocations: 0,
  });
  const observedRequests: string[] = [];
  page.on('request', (request) => observedRequests.push(request.url()));

  const response = await page.goto('/conversations/new');
  expect(response?.status()).toBe(200);
  const chat = page.getByTestId('geneway-fast-chat');
  await expect(chat).toBeVisible();
  await expect(page.getByTestId('welcome-empty')).toContainText('无需上传材料');
  await expect(page.getByLabel('给小纬发消息')).toBeEnabled();
  await expect(page.getByTestId('artifact-upload-input')).toHaveCount(0);
  await expect(page.getByTestId('artifact-card')).toHaveCount(0);
  await expect(page.getByTestId('task-card')).toHaveCount(0);
  await expect(page.getByTestId('workflow-graph')).toHaveCount(0);
  await expect.poll(() => chat.getAttribute('data-conversation-id')).toMatch(/^conversation_/u);

  const after = await authorityCounts();
  expect(after).toEqual({ ...before, conversations: before.conversations + 1 });
  expect(observedRequests.some((url) => url.includes('/chat-runs'))).toBe(false);
  expect(observedRequests.some((url) => /(?:model-gateway|\/v1\/(?:responses|chat\/completions))/iu.test(url))).toBe(false);
});
