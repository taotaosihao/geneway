import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const runId = process.env.GENEWAY_RUN_ID;
if (databaseUrl === undefined || runId === undefined || process.env.GENEWAY_GATE_A0_LIVE !== '1') {
  throw new Error('gate-a0-live requires its disposable Postgres and explicit live-provider harness');
}

test('真实 served Fast Chat 首问关联 UI、API、Postgres、Worker 与 Gateway audit', async ({ page, request }) => {
  test.setTimeout(120_000);
  const worker = JSON.parse(await readFile(`/tmp/geneway-runs/${runId}/process-boundaries/worker.json`, 'utf8')) as {
    role?: unknown; phase?: unknown; ready?: unknown; workerInstanceId?: unknown;
  };
  expect(worker).toMatchObject({ role: 'worker', phase: 'ready', ready: true });
  expect(worker.workerInstanceId).toMatch(/^e2e-worker-/u);

  const documentResponse = await page.goto('/conversations/new');
  expect(documentResponse?.status()).toBe(200);
  const chat = page.getByTestId('geneway-fast-chat');
  await expect(chat).toBeVisible();
  await expect(page.getByTestId('welcome-empty')).toBeVisible();
  await page.evaluate(() => {
    const state = { checkpoint: '', messageId: '' };
    Object.defineProperty(window, '__genewayStreamingOracle', { value: state, configurable: true });
    const capture = (): void => {
      const paragraph = document.querySelector('[data-author="xiaowei"][data-message-status="streaming"] p');
      const text = paragraph?.textContent ?? '';
      if (text.length > state.checkpoint.length) {
        state.checkpoint = text;
        state.messageId = paragraph?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '';
      }
    };
    new MutationObserver(capture).observe(document.body, {
      attributes: true, childList: true, characterData: true, subtree: true,
    });
  });
  await page.getByLabel('给小纬发消息').fill('你好，请介绍你能做什么');
  await page.getByRole('button', { name: '发送' }).click();

  await expect.poll(async () => chat.getAttribute('data-model-invocation-id'), { timeout: 15_000 }).toMatch(/^model_invocation_/u);
  const conversationId = await chat.getAttribute('data-conversation-id');
  const modelInvocationId = await chat.getAttribute('data-model-invocation-id');
  expect(conversationId).toMatch(/^conversation_/u);
  expect(modelInvocationId).toMatch(/^model_invocation_/u);
  if (conversationId === null || modelInvocationId === null) throw new Error('Fast Chat did not expose its authority identifiers');
  expect(new URL(page.url()).pathname).toBe(`/conversations/${conversationId}`);

  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __genewayStreamingOracle?: { checkpoint?: string } }
  ).__genewayStreamingOracle?.checkpoint ?? ''), { timeout: 90_000, intervals: [25, 50, 100] }).not.toBe('');
  const visiblePersistedCheckpoint = await page.evaluate(() => (
    window as typeof window & { __genewayStreamingOracle?: { checkpoint?: string; messageId?: string } }
  ).__genewayStreamingOracle ?? { checkpoint: '', messageId: '' });
  expect(visiblePersistedCheckpoint.checkpoint?.length ?? 0).toBeGreaterThan(0);
  expect(visiblePersistedCheckpoint.messageId).toMatch(/^message_/u);

  await expect.poll(async () => {
    const response = await request.get(`/api/conversations/${conversationId}`);
    const snapshot = await response.json() as { latestModelInvocation?: { status?: string } | null };
    return snapshot.latestModelInvocation?.status;
  }, { timeout: 90_000 }).toBe('completed');

  const snapshotResponse = await request.get(`/api/conversations/${conversationId}`);
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = await snapshotResponse.json() as {
    latestTaskId: string | null;
    latestModelInvocation: { id: string; assistantMessageId: string; status: string; lastEventCursor: number } | null;
    messages: readonly { id: string; author: string; body: string; status: string }[];
  };
  expect(snapshot.latestTaskId).toBeNull();
  expect(snapshot.latestModelInvocation).toMatchObject({ id: modelInvocationId, status: 'completed' });
  expect(snapshot.messages).toHaveLength(2);
  const userMessage = snapshot.messages.find((message) => message.author === 'user');
  const assistantMessage = snapshot.messages.find((message) => message.author === 'xiaowei');
  expect(userMessage).toMatchObject({ body: '你好，请介绍你能做什么', status: 'completed' });
  expect(assistantMessage?.status).toBe('completed');
  expect(assistantMessage?.body.length).toBeGreaterThan(0);
  expect(assistantMessage?.id).toBe(visiblePersistedCheckpoint.messageId);
  const completedArticle = page.locator(`[data-message-id="${assistantMessage?.id ?? ''}"]`);
  await expect(completedArticle).toHaveAttribute('data-message-status', 'completed');
  await expect(completedArticle.locator('p')).not.toBeEmpty();

  const eventsResponse = await request.get(`/api/conversations/${conversationId}/chat-runs/${modelInvocationId}/events?cursor=0`, {
    headers: { accept: 'text/event-stream' },
  });
  expect(eventsResponse.ok()).toBe(true);
  const eventStream = await eventsResponse.text();
  expect(eventStream).toContain('event: message.delta');
  expect(eventStream).toContain('event: message.completed');
  expect(eventStream).not.toMatch(/auth|token|provider payload|execution_fence|stack/iu);
  const sseCursors = [...eventStream.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
  expect(sseCursors.length).toBeGreaterThan(0);
  for (let index = 1; index < sseCursors.length; index += 1) {
    expect(sseCursors[index]).toBeGreaterThan(sseCursors[index - 1] ?? 0);
  }
  const jsonEventsResponse = await request.get(
    `/api/conversations/${conversationId}/chat-runs/${modelInvocationId}/events?cursor=0`,
  );
  expect(jsonEventsResponse.ok()).toBe(true);
  const persistedEvents = (await jsonEventsResponse.json() as { events: readonly {
    eventType?: string; assistantMessageId?: string; checkpoint?: string; contentVersion?: number;
  }[] }).events;
  const persistedDeltas = persistedEvents.filter((event) => event.eventType === 'message.delta');
  expect(persistedDeltas.length).toBeGreaterThan(0);
  expect(persistedDeltas.map((event) => event.assistantMessageId))
    .toEqual(persistedDeltas.map(() => assistantMessage?.id));
  expect(persistedDeltas.every((event) => (event.checkpoint?.length ?? 0) > 0)).toBe(true);
  expect(persistedDeltas.every((event) => assistantMessage?.body.startsWith(event.checkpoint ?? '') ?? false)).toBe(true);
  for (let index = 1; index < persistedDeltas.length; index += 1) {
    expect(persistedDeltas[index]?.contentVersion ?? 0).toBeGreaterThan(persistedDeltas[index - 1]?.contentVersion ?? 0);
  }
  const persistedTerminal = persistedEvents.find((event) => event.eventType === 'message.completed');
  expect(persistedTerminal).toMatchObject({
    assistantMessageId: assistantMessage?.id,
    checkpoint: assistantMessage?.body,
  });

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const correlated = await pool.query<{
      conversation_id: string; model_invocation_id: string; user_message_id: string; assistant_message_id: string;
      invocation_status: string; dispatch_status: string; worker_instance_id: string; audit_outcome: string;
      route_profile: string; provider_revision: string; model_revision: string; delta_count: number;
      attested: boolean; receipt_digest: string; gateway_receipt_jti: string; consumed_tokens: number;
    }>(`SELECT invocation.conversation_id,invocation.id model_invocation_id,
      invocation.user_message_id,invocation.assistant_message_id,invocation.status invocation_status,
      dispatch.status dispatch_status,dispatch.worker_instance_id,audit.outcome audit_outcome,
      audit.route_profile,audit.provider_revision,audit.model_revision,
      audit.attested,audit.receipt_digest,audit.gateway_receipt_jti,
      (SELECT count(*)::int FROM model_invocation_token_authorizations token
        WHERE token.tenant_id=invocation.tenant_id AND token.model_invocation_id=invocation.id
          AND token.consumed_at IS NOT NULL) consumed_tokens,
      count(event.id) FILTER (WHERE event.event_type='message.delta')::int delta_count
      FROM model_invocations invocation
      JOIN chat_turn_dispatches dispatch ON dispatch.tenant_id=invocation.tenant_id
        AND dispatch.model_invocation_id=invocation.id
      JOIN model_gateway_audit audit ON audit.tenant_id=invocation.tenant_id
        AND audit.model_invocation_id=invocation.id
      LEFT JOIN chat_run_events event ON event.tenant_id=invocation.tenant_id
        AND event.model_invocation_id=invocation.id
      WHERE invocation.tenant_id='tenant_local' AND invocation.id=$1
      GROUP BY invocation.tenant_id,invocation.conversation_id,invocation.id,invocation.user_message_id,invocation.assistant_message_id,
        invocation.status,dispatch.status,dispatch.worker_instance_id,audit.outcome,audit.route_profile,
        audit.provider_revision,audit.model_revision,audit.attested,audit.receipt_digest,audit.gateway_receipt_jti`, [modelInvocationId]);
    expect(correlated.rows).toEqual([{
      conversation_id: conversationId,
      model_invocation_id: modelInvocationId,
      user_message_id: userMessage?.id,
      assistant_message_id: assistantMessage?.id,
      invocation_status: 'completed',
      dispatch_status: 'completed',
      worker_instance_id: worker.workerInstanceId,
      audit_outcome: 'completed',
      route_profile: 'codex_subscription_dev',
      provider_revision: '@openai-oauth/ai-sdk@2.0.0',
      model_revision: 'gpt-5.4-mini',
      attested: true,
      receipt_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      gateway_receipt_jti: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      consumed_tokens: 1,
      delta_count: expect.any(Number),
    }]);
    expect(correlated.rows[0]?.delta_count).toBeGreaterThan(0);
    const forbidden = await pool.query<{ business_tasks: number; evidence: number; artifacts: number }>(`SELECT
      (SELECT count(*)::int FROM business_tasks WHERE tenant_id='tenant_local' AND conversation_id=$1) business_tasks,
      (SELECT count(*)::int FROM evidence_items evidence JOIN business_tasks task
        ON task.tenant_id=evidence.tenant_id AND task.id=evidence.business_task_id
        WHERE task.tenant_id='tenant_local' AND task.conversation_id=$1) evidence,
      (SELECT count(*)::int FROM artifacts WHERE tenant_id='tenant_local' AND conversation_id=$1) artifacts`, [conversationId]);
    expect(forbidden.rows).toEqual([{ business_tasks: 0, evidence: 0, artifacts: 0 }]);
  } finally {
    await pool.end();
  }

  await page.reload();
  await expect(chat).toHaveAttribute('data-conversation-id', conversationId);
  await expect(page.locator(`[data-message-id="${assistantMessage?.id ?? ''}"]`)).toContainText(assistantMessage?.body ?? '');
  await page.getByTestId('material-analysis-link').click();
  await expect(page).toHaveURL(/\/conversations\/new\?capability=solution\.analysis\.v1$/u);
  await expect(page.getByTestId('geneway-app')).toBeVisible();
  await expect(page.getByTestId('artifact-upload-card')).toBeVisible();
  await expect(page.getByTestId('task-card')).toHaveCount(0);
});
