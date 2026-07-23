import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const runId = process.env.GENEWAY_RUN_ID;
const devUpRunId = process.env.GENEWAY_DEV_UP_RUN_ID;
const lanBaseUrl = process.env.GENEWAY_LAN_BASE_URL;
const secretCanary = process.env.GENEWAY_E2E_SECRET_CANARY;
if (databaseUrl === undefined || runId === undefined || devUpRunId === undefined || lanBaseUrl === undefined
  || secretCanary === undefined) {
  throw new Error('Gate A0 LAN regression requires its disposable DB, run IDs, and actual LAN origin');
}

type ConversationSnapshot = Readonly<{
  id: string;
  latestTaskId: string | null;
  latestModelInvocation: Readonly<{
    id: string;
    assistantMessageId: string;
    status: string;
  }> | null;
  messages: readonly Readonly<{ id: string; author: string; body: string; status: string }>[];
}>;

async function send(page: Page, conversationId: string, content: string, previousInvocationId = ''): Promise<string> {
  await page.getByLabel('给小纬发消息').fill(content);
  const submission = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/conversations/${conversationId}/chat-runs`);
  await page.getByRole('button', { name: '发送' }).click();
  const response = await submission;
  const body = await response.json() as { modelInvocationId?: string; error?: unknown };
  expect(response.status(), JSON.stringify(body)).toBe(202);
  expect(body.modelInvocationId).toMatch(/^model_invocation_/u);
  if (body.modelInvocationId === undefined) throw new Error('LAN Fast Chat did not expose a ModelInvocation ID');
  expect(body.modelInvocationId).not.toBe(previousInvocationId);
  await expect(page.getByTestId('geneway-fast-chat')).toHaveAttribute('data-model-invocation-id', body.modelInvocationId);
  return body.modelInvocationId;
}

async function waitForStatus(
  request: APIRequestContext,
  conversationId: string,
  invocationId: string,
  status: string,
): Promise<ConversationSnapshot> {
  let latest: ConversationSnapshot | undefined;
  await expect.poll(async () => {
    const response = await request.get(`/api/conversations/${conversationId}`);
    expect(response.ok()).toBe(true);
    latest = await response.json() as ConversationSnapshot;
    return latest.latestModelInvocation?.id === invocationId ? latest.latestModelInvocation.status : undefined;
  }, { timeout: 90_000, intervals: [50, 100, 200] }).toBe(status);
  if (latest === undefined) throw new Error('Conversation snapshot was not observed');
  return latest;
}

test('实际 LAN 双浏览器共享 Conversation、上下文、取消并保持材料门', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const pool = new Pool({ connectionString: databaseUrl });
  const contextA = await browser.newContext({ baseURL: lanBaseUrl });
  const contextB = await browser.newContext({ baseURL: lanBaseUrl });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const marker = `GW-LAN-${runId.replaceAll(/[^A-Za-z0-9]/gu, '').slice(-18)}`;
  try {
    const defaultResponse = await pageA.goto('/conversations/new');
    expect(defaultResponse?.status()).toBe(200);
    const fastChatA = pageA.getByTestId('geneway-fast-chat');
    await expect(fastChatA).toBeVisible();
    await expect(fastChatA).toHaveAttribute('data-conversation-id', /^conversation_/u);
    const conversationId = await fastChatA.getAttribute('data-conversation-id');
    expect(conversationId).toMatch(/^conversation_/u);
    if (conversationId === null) throw new Error('Default LAN page did not create a Conversation');

    const firstInvocationId = await send(pageA, conversationId, `请记住唯一短标记 ${marker}，并只回复“已记住”。`);
    await waitForStatus(request, conversationId, firstInvocationId, 'completed');

    const sharedResponse = await pageB.goto(`/conversations/${conversationId}`);
    expect(sharedResponse?.status()).toBe(200);
    await expect(pageB.getByTestId('geneway-fast-chat')).toHaveAttribute('data-conversation-id', conversationId);
    await expect(pageB.getByTestId('message-thread')).toContainText(marker);
    const failedBrowserRequests: string[] = [];
    const successfulBrowserEventResponses: string[] = [];
    pageB.on('requestfailed', (failedRequest) => {
      if (failedRequest.failure()?.errorText.includes('INTERNET_DISCONNECTED') === true) {
        failedBrowserRequests.push(failedRequest.url());
      }
    });
    pageB.on('response', (response) => {
      if (response.status() === 200 && response.request().method() === 'GET'
        && response.url().includes('/chat-runs/') && response.url().includes('/events?cursor=')) {
        successfulBrowserEventResponses.push(response.url());
      }
    });
    const followupInvocationId = await send(pageB, conversationId, '刚才要求你记住的唯一短标记是什么？请只回复该标记。', firstInvocationId);
    const followup = await waitForStatus(request, conversationId, followupInvocationId, 'completed');
    const followupAnswer = followup.messages.find((message) => message.id === followup.latestModelInvocation?.assistantMessageId);
    expect(followupAnswer).toMatchObject({ author: 'xiaowei', status: 'completed' });
    expect(followupAnswer?.body).toContain(marker);
    await expect(pageB.locator(`[data-message-id="${followupAnswer?.id ?? ''}"]`)).toContainText(marker);

    await pageA.goto(`/conversations/${conversationId}`);
    await expect(pageA.getByTestId('message-thread')).toContainText(marker);
    const longInvocationId = await send(
      pageB,
      conversationId,
      '从下一字符开始，连续输出汉字“联”直到达到输出上限。不要解释、不要换行、不要省略、不要提前停止。',
      followupInvocationId,
    );
    let longAssistantMessageId: string | undefined;
    await expect.poll(async () => {
      const response = await request.get(`/api/conversations/${conversationId}`);
      const snapshot = await response.json() as ConversationSnapshot;
      if (snapshot.latestModelInvocation?.id === longInvocationId) {
        longAssistantMessageId = snapshot.latestModelInvocation.assistantMessageId;
      }
      return longAssistantMessageId;
    }, { timeout: 10_000, intervals: [10, 20, 40] }).toMatch(/^message_/u);
    const longAnswerB = pageB.locator(`[data-message-id="${longAssistantMessageId ?? ''}"]`);
    await expect(longAnswerB).toBeVisible();
    const invocationCountBeforeReconnect = await pool.query<{ count: number }>(`SELECT count(*)::int count FROM model_invocations
      WHERE tenant_id='tenant_local' AND conversation_id=$1`, [conversationId]);
    let browserTextAtDisconnect = '';
    let successfulResponsesBeforeReconnect = 0;
    try {
      await contextB.setOffline(true);
      await expect.poll(() => failedBrowserRequests.filter((url) => url.includes(
        `/chat-runs/${longInvocationId}/events`,
      )).length, { timeout: 10_000, intervals: [25, 50, 100] }).toBeGreaterThan(0);
      browserTextAtDisconnect = await longAnswerB.textContent() ?? '';
      successfulResponsesBeforeReconnect = successfulBrowserEventResponses.filter((url) => url.includes(
        `/chat-runs/${longInvocationId}/events`,
      )).length;
    } finally {
      await contextB.setOffline(false);
    }
    const injectedReconnectFailures = failedBrowserRequests.filter((url) => url.includes(
      `/chat-runs/${longInvocationId}/events`,
    )).length;
    expect(injectedReconnectFailures).toBeGreaterThan(0);
    await expect.poll(() => successfulBrowserEventResponses.filter((url) => url.includes(
      `/chat-runs/${longInvocationId}/events`,
    )).length, { timeout: 15_000, intervals: [25, 50, 100] }).toBeGreaterThan(successfulResponsesBeforeReconnect);
    await expect.poll(async () => await longAnswerB.textContent() ?? '', {
      timeout: 15_000, intervals: [25, 50, 100],
    }).not.toBe(browserTextAtDisconnect);
    await expect(longAnswerB.locator('p')).not.toBeEmpty();
    const invocationCountAfterReconnect = await pool.query<{ count: number }>(`SELECT count(*)::int count FROM model_invocations
      WHERE tenant_id='tenant_local' AND conversation_id=$1`, [conversationId]);
    expect(invocationCountAfterReconnect.rows).toEqual(invocationCountBeforeReconnect.rows);
    await expect.poll(async () => {
      const checkpoint = await pool.query<{ body_length: number }>(`SELECT length(message.body)::int body_length
        FROM model_invocations invocation
        JOIN messages message ON message.tenant_id=invocation.tenant_id AND message.id=invocation.assistant_message_id
        WHERE invocation.tenant_id='tenant_local' AND invocation.id=$1`, [longInvocationId]);
      return checkpoint.rows[0]?.body_length ?? 0;
    }, { timeout: 90_000, intervals: [10, 20, 40] }).toBeGreaterThan(0);
    await pageA.reload();
    await expect(pageA.getByTestId('stop-generation')).toBeVisible();
    await pageA.getByTestId('stop-generation').click();
    const canceled = await waitForStatus(request, conversationId, longInvocationId, 'canceled');
    const canceledAnswer = canceled.messages.find((message) => message.id === canceled.latestModelInvocation?.assistantMessageId);
    expect(canceledAnswer).toMatchObject({ author: 'xiaowei', status: 'canceled' });
    expect(canceledAnswer?.body.length).toBeGreaterThan(0);
    await pageB.reload();
    await expect(pageB.locator(`[data-message-id="${canceledAnswer?.id ?? ''}"]`)).toHaveAttribute('data-message-status', 'canceled');

    const tasksBefore = await pool.query<{ count: number }>("SELECT count(*)::int count FROM business_tasks WHERE tenant_id='tenant_local'");
    await pageA.getByTestId('material-analysis-link').click();
    await expect(pageA).toHaveURL(new RegExp('/conversations/new\\?capability=solution\\.analysis\\.v1$', 'u'));
    await expect(pageA.getByTestId('artifact-upload-card')).toBeVisible();
    await expect(pageA.getByTestId('task-card')).toHaveCount(0);
    await expect.poll(() => pageA.evaluate(() => localStorage.getItem('geneway.conversationId'))).toMatch(/^conversation_/u);
    const analysisConversationId = await pageA.evaluate(() => localStorage.getItem('geneway.conversationId'));
    expect(analysisConversationId).toMatch(/^conversation_/u);
    if (analysisConversationId === null) throw new Error('Material route did not establish its gated Conversation');

    const denied = await pageA.evaluate(async ({ conversationId: targetConversationId, validationRunId }) => {
      const response = await fetch('/api/business-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `lan-material-denied-${validationRunId}` },
        body: JSON.stringify({
          conversationId: targetConversationId,
          capabilityId: 'solution.analysis.v1',
          inputRef: { kind: 'document_snapshot', documentSnapshotId: 'document_snapshot_missing' },
          expertTarget: { mode: 'auto' },
        }),
      });
      return { status: response.status, body: await response.json() as unknown };
    }, { conversationId: analysisConversationId, validationRunId: runId });
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ error: { code: 'DOCUMENT_SNAPSHOT_NOT_FOUND' } });
    const tasksAfter = await pool.query<{ count: number }>("SELECT count(*)::int count FROM business_tasks WHERE tenant_id='tenant_local'");
    const materialConversationTasks = await pool.query<{ count: number }>(`SELECT count(*)::int count FROM business_tasks
      WHERE tenant_id='tenant_local' AND conversation_id=$1`, [analysisConversationId]);
    expect(tasksAfter.rows).toEqual(tasksBefore.rows);
    expect(materialConversationTasks.rows).toEqual([{ count: 0 }]);

    const capabilitiesResponse = await request.get('/api/capabilities');
    expect(capabilitiesResponse.ok()).toBe(true);
    const capabilities = await capabilitiesResponse.json() as readonly Record<string, unknown>[];
    expect(capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'xiaowei.chat.v1', status: 'internal', simulation: false, toolChoice: 'none' }),
      expect.objectContaining({
        id: 'solution.analysis.v1', fixtureOnly: true, simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false,
      }),
    ]));

    const evidenceDirectory = `/tmp/geneway-runs/${runId}/gate-a0-lan`;
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(`${evidenceDirectory}/browser-db.json`, `${JSON.stringify({
      schemaVersion: 'geneway-gate-a0-lan-browser-db/1',
      runId,
      devUpRunId,
      lanOrigin: lanBaseUrl,
      defaultPath: '/conversations/new',
      contexts: 2,
      sharedPrincipal: { tenantId: 'tenant_local', userId: 'user_local' },
      sharedConversationId: conversationId,
      contextMarkerObserved: true,
      canceledByOtherBrowser: true,
      canceledInvocationId: longInvocationId,
      materialAnalysisVisibleNavigation: true,
      materialDeniedCode: 'DOCUMENT_SNAPSHOT_NOT_FOUND',
      materialConversationTaskCount: 0,
      solutionAnalysisMode: 'fixture/fake simulation',
    }, null, 2)}\n`, { mode: 0o600 });
    const publicSurface = `${await pageA.content()}\n${await pageB.content()}\n${JSON.stringify(capabilities)}\n${JSON.stringify(canceled)}`;
    const forbiddenMarkers = [
      secretCanary,
      ['/home/gewu/.codex', 'auth.json'].join('/'),
      ['GENEWAY_CODEX', 'SUBSCRIPTION_AUTH_FILE'].join('_'),
      'access_token',
      'refresh_token',
    ];
    for (const forbidden of forbiddenMarkers) {
      if (publicSurface.includes(forbidden)) throw new Error('LAN browser public boundary exposed forbidden credential material');
    }
    const oracleDirectory = `/tmp/geneway-runs/${runId}/secret-oracles`;
    await mkdir(oracleDirectory, { recursive: true, mode: 0o700 });
    await writeFile(`${oracleDirectory}/browser-public-boundary.json`, `${JSON.stringify({
      schemaVersion: 'geneway-browser-secret-oracle/1',
      checked: true,
      publicResponseAndDomClean: true,
      browserReconnectFaultInjected: injectedReconnectFailures > 0,
      canarySha256: createHash('sha256').update(secretCanary, 'utf8').digest('hex'),
      forbiddenMarkerClasses: ['isolated-process-canary', 'auth-path', 'auth-env-name', 'token-field-names'],
    })}\n`, { mode: 0o600 });
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
    await pool.end();
  }
});
