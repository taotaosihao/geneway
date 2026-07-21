import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://geneway:geneway@127.0.0.1:55433/geneway_test';
const CONTROL_PLANE_URL = `http://127.0.0.1:${process.env.GENEWAY_CONTROL_PLANE_PORT ?? '3100'}`;
const DOCUMENT_FIXTURE_PATH = path.resolve(process.cwd(), 'scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt');

async function uploadAndSelectDocument(page: Page): Promise<void> {
  const fixture = await readFile(DOCUMENT_FIXTURE_PATH);
  await page.getByTestId('artifact-upload-input').setInputFiles({
    name: 'solution-analysis-demo-v2.txt',
    mimeType: 'text/plain',
    buffer: fixture,
  });
  const card = page.getByTestId('artifact-card').filter({ hasText: 'solution-analysis-demo-v2.txt' });
  await expect(card.getByTestId('artifact-eligibility')).toContainText('可用于模拟分析');
  await card.getByRole('button', { name: '选择用于分析' }).click();
  await expect(card.getByRole('button', { name: '已选择用于本次任务' })).toBeVisible();
}

async function assertThreeColumnLayout(page: Page) {
  const boxes = await Promise.all(['.sidebar', '.conversation-pane', '.inspector'].map(async (selector) => page.locator(selector).boundingBox()));
  for (const box of boxes) expect(box).not.toBeNull();
  expect(boxes[0]?.x).toBe(0);
  expect(boxes[1]?.x).toBeGreaterThan(boxes[0]?.x ?? 0);
  expect(boxes[2]?.x).toBeGreaterThan(boxes[1]?.x ?? 0);
  expect((boxes[2]?.x ?? 0) + (boxes[2]?.width ?? 0)).toBeLessThanOrEqual(1440);
}

async function assertNodeBoxesDoNotOverlap(page: Page) {
  const boxes = await page.locator('[data-testid="workflow-graph"] .react-flow__node').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
  }));
  for (let left = 0; left < boxes.length; left += 1) for (let right = left + 1; right < boxes.length; right += 1) {
    const a = boxes[left]; const b = boxes[right];
    if (a === undefined || b === undefined) continue;
    expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBeTruthy();
  }
}

test('小纬完成真实 served UI 方案分析纵切并保持权威实体关联', async ({ page, request }) => {
  const served = new Set<string>();
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') served.add(`${url.pathname}:${String(response.status())}`);
  });

  await page.goto('/conversations/new?capability=solution.analysis.v1');
  await expect(page).toHaveTitle(/小纬/);
  await assertThreeColumnLayout(page);
  await expect(page.getByTestId('simulation-notice').first()).toContainText('runtimeMode=fake');
  await expect(page.getByTestId('simulation-notice').first()).toContainText('businessDecisionAllowed=false');
  await expect(page.getByLabel('制造业状态入口')).toContainText('设备异常待处理');
  await expect(page.getByLabel('制造业状态入口')).toContainText('产能进度落后');
  for (const button of await page.getByLabel('制造业状态入口').getByRole('button').all()) await expect(button).toBeDisabled();

  await uploadAndSelectDocument(page);
  await page.getByLabel('专家路线').selectOption('team.solution.core');
  await page.getByLabel('给小纬发消息').fill('请小纬组织方案专家团分析已选择的脱敏材料');
  await page.getByRole('button', { name: '发送' }).click();

  const card = page.getByTestId('task-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('方案专家团');
  await expect(card).toContainText('simulation=true');
  const taskId = await card.getAttribute('data-task-id');
  const workflowId = await card.getAttribute('data-workflow-id');
  const workflowHash = await card.getAttribute('data-workflow-hash');
  expect(taskId).toBeTruthy(); expect(workflowId).toBeTruthy(); expect(workflowHash).toMatch(/^[a-f0-9]{64}$/);

  const authors = await page.locator('[data-author]').evaluateAll((elements) => [...new Set(elements.map((element) => element.getAttribute('data-author')))].sort());
  expect(authors).toEqual(['user']);
  await expect(page.locator('[data-author="expert"], [data-author="team"]')).toHaveCount(0);

  const graph = page.getByTestId('workflow-graph');
  await expect(graph).toBeVisible();
  await expect(graph.locator('.react-flow__node')).toHaveCount(7);
  for (const label of ['读取脱敏材料', '提取需求', '检查矛盾', '生成方案', '核验来源', '检查结果质量', '发布模拟结论']) {
    await expect(graph).toContainText(label);
  }
  await expect(page.getByTestId('workflow-id')).toHaveText(workflowId ?? '');
  await expect(page.getByTestId('workflow-hash')).toHaveText(workflowHash ?? '');
  const dialogBox = await page.locator('.workflow-dialog').boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox?.width).toBeGreaterThan(900); expect(dialogBox?.width).toBeLessThanOrEqual(1360);
  expect(dialogBox?.height).toBeLessThanOrEqual(860);
  await assertNodeBoxesDoNotOverlap(page);

  await page.getByRole('button', { name: '关闭' }).click();
  let executeResponse: { status?: string } | undefined;
  page.on('response', async (response) => {
    if (response.url().endsWith(`/api/business-tasks/${taskId ?? ''}/execute`)) executeResponse = await response.json() as { status?: string };
  });
  await page.getByRole('button', { name: '批准并运行模拟任务' }).click();
  const observedProgress = new Set<number>();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const text = await card.locator('.progress-copy').textContent();
    const completed = /已完成 (\d+) \/ 7/.exec(text ?? '')?.[1];
    if (completed !== undefined) observedProgress.add(Number(completed));
    if (await page.getByTestId('result-card').isVisible()) break;
    await page.waitForTimeout(15);
  }
  await expect(page.getByTestId('result-card')).toBeVisible();
  expect(executeResponse).toEqual({ taskId, status: 'accepted' });
  expect([...observedProgress].some((value) => value > 0 && value < 7)).toBeTruthy();
  await expect(page.getByTestId('published-claim')).toContainText('当前材料明确要求生产工单跟踪和质量追溯');
  await expect(page.getByTestId('published-claim')).toContainText('已绑定 Evidence');
  await expect(page.getByTestId('rejected-claim')).toContainText('当前材料要求直接控制设备');
  await expect(page.getByTestId('rejected-claim')).toContainText('未发布');
  await expect(card).toContainText('已完成 7 / 7 个步骤');
  await expect(card).toContainText('SSE cursor');

  const snapshotResponse = await request.get(`${CONTROL_PLANE_URL}/api/business-tasks/${taskId ?? ''}`);
  expect(snapshotResponse.ok()).toBeTruthy();
  const snapshot = await snapshotResponse.json() as {
    id: string; conversationId: string; status: string; workflowVersion: { id: string; hash: string }; approval: { id: string; status: string; subjectDigest: string };
    expertTarget: { mode: string; teamId?: string }; eventWatermark: number; simulation: boolean; runtimeMode: string; businessDecisionAllowed: boolean;
    steps: readonly { status: string }[]; result: { simulation: boolean; runtimeMode: string; businessDecisionAllowed: boolean };
    claims: readonly { text: string; status: string }[]; evidence: readonly { excerptSha256: string }[];
  };
  expect(snapshot).toMatchObject({ id: taskId, status: 'completed', workflowVersion: { id: workflowId, hash: workflowHash }, expertTarget: { mode: 'team', teamId: 'team.solution.core' }, simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false });
  expect(snapshot.result).toMatchObject({ simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false });
  expect(snapshot.steps).toHaveLength(7); expect(snapshot.steps.every((step) => step.status === 'completed')).toBeTruthy();
  expect(snapshot.claims).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: '当前材料明确要求生产工单跟踪和质量追溯', status: 'published' }),
    expect.objectContaining({ text: '当前材料要求直接控制设备', status: 'rejected' }),
  ]));
  expect(snapshot.evidence).toHaveLength(1);

  const [workflowResponse, approvalResponse, eventsResponse] = await Promise.all([
    request.get(`${CONTROL_PLANE_URL}/api/workflow-versions/${workflowId ?? ''}`),
    request.get(`${CONTROL_PLANE_URL}/api/approvals/${snapshot.approval.id}`),
    request.get(`${CONTROL_PLANE_URL}/api/business-tasks/${taskId ?? ''}/events?afterCursor=0`),
  ]);
  const workflow = await workflowResponse.json() as { id: string; hash: string };
  const approval = await approvalResponse.json() as { id: string; business_task_id: string; status: string; subject_digest: string; subject: { workflowVersionId: string; workflowHash: string } };
  const events = await eventsResponse.json() as { events: readonly { cursor: number; simulation: boolean; runtime_mode: string; business_decision_allowed: boolean }[] };
  expect(workflow).toEqual(expect.objectContaining({ id: workflowId, hash: workflowHash }));
  expect(approval).toEqual(expect.objectContaining({ id: snapshot.approval.id, business_task_id: taskId, status: 'approved', subject_digest: snapshot.approval.subjectDigest }));
  expect(approval.subject).toEqual(expect.objectContaining({ workflowVersionId: workflowId, workflowHash }));
  expect(events.events.length).toBeGreaterThan(10);
  expect(events.events.every((event) => event.simulation && event.runtime_mode === 'fake' && event.business_decision_allowed === false)).toBeTruthy();
  expect(Math.max(...events.events.map((event) => event.cursor))).toBe(snapshot.eventWatermark);

  const conversationResponse = await request.get(`${CONTROL_PLANE_URL}/api/conversations/${snapshot.conversationId}`);
  const authorityConversation = await conversationResponse.json() as { messages: readonly { author: string; body: string }[] };
  const domConversation = await page.locator('[data-author]').evaluateAll((elements) => elements.map((element) => ({
    author: element.getAttribute('data-author'), body: element.querySelector('p')?.textContent ?? '',
  })));
  expect(domConversation).toEqual(authorityConversation.messages.map((message) => ({ author: message.author, body: message.body })));

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const db = await pool.query<{
      id: string; workflow_version_id: string; workflow_hash: string; approval_status: string; max_cursor: string;
      published_claims: string; rejected_claims: string; evidence_count: string; simulation: boolean; runtime_mode: string; business_decision_allowed: boolean;
    }>(`SELECT t.id,t.workflow_version_id,t.workflow_hash,a.status approval_status,
      (SELECT max(cursor)::text FROM business_task_events e WHERE e.tenant_id=t.tenant_id AND e.business_task_id=t.id) max_cursor,
      (SELECT count(*)::text FROM claims c WHERE c.tenant_id=t.tenant_id AND c.business_task_id=t.id AND c.status='published') published_claims,
      (SELECT count(*)::text FROM claims c WHERE c.tenant_id=t.tenant_id AND c.business_task_id=t.id AND c.status='rejected') rejected_claims,
      (SELECT count(*)::text FROM evidence_items r WHERE r.tenant_id=t.tenant_id AND r.business_task_id=t.id) evidence_count,
      t.simulation,t.runtime_mode,t.business_decision_allowed
      FROM business_tasks t JOIN approval_versions a ON a.tenant_id=t.tenant_id AND a.business_task_id=t.id
      WHERE t.tenant_id='tenant_local' AND t.id=$1`, [taskId]);
    expect(db.rows).toEqual([expect.objectContaining({ id: taskId, workflow_version_id: workflowId, workflow_hash: workflowHash, approval_status: 'approved', max_cursor: String(snapshot.eventWatermark), published_claims: '1', rejected_claims: '1', evidence_count: '1', simulation: true, runtime_mode: 'fake', business_decision_allowed: false })]);
  } finally { await pool.end(); }

  const cursorBeforeRefresh = Number(await page.getByTestId('sse-cursor').textContent());
  await page.reload();
  await expect(page.getByTestId('task-id')).toHaveText(taskId ?? '');
  await expect(page.getByLabel('专家路线')).toHaveValue('team.solution.core');
  await expect(page.getByTestId('result-card')).toBeVisible();
  await expect(page.getByTestId('sse-cursor')).toHaveText(String(snapshot.eventWatermark));
  expect(cursorBeforeRefresh).toBe(snapshot.eventWatermark);

  expect([...served].some((entry) => entry.startsWith('/conversations/new:200'))).toBeTruthy();
  expect([...served].some((entry) => entry.startsWith('/src/main.tsx:200'))).toBeTruthy();
  expect([...served].some((entry) => entry.includes('.css:200'))).toBeTruthy();
  expect([...served].some((entry) => entry.startsWith('/api/business-tasks:201'))).toBeTruthy();
  expect([...served].some((entry) => entry.includes(`/api/business-tasks/${taskId ?? ''}:200`))).toBeTruthy();
});

for (const route of [
  { label: 'auto', option: 'auto', expected: { mode: 'auto' } },
  { label: 'expert', option: 'expert.solution.architect', expected: { mode: 'expert', expertId: 'expert.solution.architect' } },
] as const) {
  test(`${route.label} 路由通过真实 served UI 创建权威任务`, async ({ page, request }) => {
    await page.goto('/conversations/new?capability=solution.analysis.v1');
    await uploadAndSelectDocument(page);
    await page.getByLabel('专家路线').selectOption(route.option);
    await page.getByLabel('给小纬发消息').fill(`验证 ${route.label} 路由`);
    await page.getByRole('button', { name: '发送' }).click();
    const taskId = await page.getByTestId('task-card').getAttribute('data-task-id');
    const response = await request.get(`${CONTROL_PLANE_URL}/api/business-tasks/${taskId ?? ''}`);
    expect(response.ok()).toBeTruthy();
    const snapshot = await response.json() as { expertTarget: unknown; status: string };
    expect(snapshot).toEqual(expect.objectContaining({ expertTarget: route.expected, status: 'awaiting_approval' }));
  });
}

test('未知 capability 在 UI 与 API 均 fail closed 为 NOT_OPEN', async ({ page, request }) => {
  await page.goto('/conversations/new?capability=unknown.capability.v1');
  await expect(page.getByTestId('not-open')).toContainText('NOT_OPEN');
  await expect(page.getByTestId('geneway-app')).toHaveCount(0);
  const response = await request.get(`${CONTROL_PLANE_URL}/api/capabilities/unknown.capability.v1`);
  expect(response.status()).toBe(422);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: expect.objectContaining({ code: 'NOT_OPEN' }) }));
});
