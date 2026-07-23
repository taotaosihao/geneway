import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.GENEWAY_E2E_DATABASE_URL;
const runId = process.env.GENEWAY_RUN_ID;
const secretCanary = process.env.GENEWAY_E2E_SECRET_CANARY;
const workerHealthPort = Number(process.env.GENEWAY_WORKER_HEALTH_PORT);
const modelGatewaySupervisorPort = Number(process.env.GENEWAY_MODEL_GATEWAY_SUPERVISOR_PORT);
const workerTokenFile = process.env.GENEWAY_WORKER_TOKEN_FILE;
if (databaseUrl === undefined || runId === undefined || secretCanary === undefined || workerTokenFile === undefined
  || !Number.isInteger(workerHealthPort) || !Number.isInteger(modelGatewaySupervisorPort)
  || process.env.GENEWAY_GATE_A0_LIVE !== '1') {
  throw new Error('gate-a0-live requires its disposable Postgres and explicit live-provider harness');
}

type ProcessIdentity = Readonly<{
  pid: number; procStartTicks: string; generation: number; workerInstanceId?: string;
}>;

async function supervisorRequest<T>(port: number, route: string, body: unknown): Promise<Readonly<{ status: number; body: T }>> {
  const token = (await readFile(workerTokenFile ?? '', 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${String(port)}${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as T };
}

async function waitSupervisorReady(port: number): Promise<void> {
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${String(port)}/health`)).ok; }
    catch { return false; }
  }, { timeout: 20_000, intervals: [25, 50, 100] }).toBe(true);
}

test('真实 served Fast Chat 追问上下文并用停止生成完成 cancel fencing', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.goto('/conversations/new');
  const chat = page.getByTestId('geneway-fast-chat');
  await expect(chat).toBeVisible();
  const conversationId = await chat.getAttribute('data-conversation-id');
  expect(conversationId).toMatch(/^conversation_/u);
  if (conversationId === null) throw new Error('Fast Chat did not expose a Conversation ID');
  const marker = `GW-A02-${runId.replaceAll(/[^A-Za-z0-9]/gu, '').slice(-16)}`;

  const send = async (content: string, previousInvocationId = ''): Promise<string> => {
    await page.getByLabel('给小纬发消息').fill(content);
    const submission = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/conversations/${conversationId}/chat-runs`);
    await page.getByRole('button', { name: '发送' }).click();
    const response = await submission;
    const body = await response.json() as { modelInvocationId?: string; error?: unknown };
    expect(response.status(), JSON.stringify(body)).toBe(202);
    const invocationId = body.modelInvocationId;
    expect(invocationId).toMatch(/^model_invocation_/u);
    if (invocationId === undefined) throw new Error('Fast Chat did not expose a ModelInvocation ID');
    expect(invocationId).not.toBe(previousInvocationId);
    await expect(chat).toHaveAttribute('data-model-invocation-id', invocationId);
    return invocationId;
  };
  const waitForStatus = async (invocationId: string, status: string): Promise<Record<string, unknown>> => {
    let latest: Record<string, unknown> = {};
    await expect.poll(async () => {
      const response = await request.get(`/api/conversations/${conversationId}`);
      latest = await response.json() as Record<string, unknown>;
      const invocation = latest.latestModelInvocation as { id?: string; status?: string } | null | undefined;
      return invocation?.id === invocationId ? invocation.status : undefined;
    }, { timeout: 90_000, intervals: [50, 100, 150] }).toBe(status);
    return latest;
  };

  const firstInvocationId = await send(`请记住唯一短标记 ${marker}，并只回复“已记住”。`);
  const firstSnapshot = await waitForStatus(firstInvocationId, 'completed');
  const firstInvocation = firstSnapshot.latestModelInvocation as { assistantMessageId?: string };
  const firstMessages = firstSnapshot.messages as readonly { id: string; author: string; body: string }[];
  const firstUserMessage = firstMessages.find((message) => message.author === 'user');
  expect(firstInvocation.assistantMessageId).toMatch(/^message_/u);
  expect(firstUserMessage?.body).toContain(marker);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const poisonConversation = await request.post('/api/conversations', {
      headers: { 'idempotency-key': `a02-poison-${runId}` },
    });
    expect(poisonConversation.ok()).toBe(true);
    const poisonConversationId = (await poisonConversation.json() as { id: string }).id;
    await pool.query(`INSERT INTO messages
      (tenant_id,id,conversation_id,author,body,status,content_version,completed_at)
      VALUES ('tenant_local',$2,$1,'user',$4,'completed',1,now()),
             ('tenant_local',$3,$1,'xiaowei',$5,'completed',1,now())`, [
      poisonConversationId, `message_poison_user_${runId}`, `message_poison_assistant_${runId}`,
      `另一个会话的禁入标记 POISON-${marker}`, `POISON-${marker}`,
    ]);

    const failedBrowserRequests: string[] = [];
    const successfulBrowserEventResponses: string[] = [];
    page.on('requestfailed', (failedRequest) => {
      if (failedRequest.failure()?.errorText.includes('INTERNET_DISCONNECTED') === true) {
        failedBrowserRequests.push(failedRequest.url());
      }
    });
    page.on('response', (response) => {
      if (response.status() === 200 && response.request().method() === 'GET'
        && response.url().includes('/chat-runs/') && response.url().includes('/events?cursor=')) {
        successfulBrowserEventResponses.push(response.url());
      }
    });
    const followupInvocationId = await send('刚才要求你记住的唯一短标记是什么？请只回复该标记。', firstInvocationId);
    const followupSnapshot = await waitForStatus(followupInvocationId, 'completed');
    const followupInvocation = followupSnapshot.latestModelInvocation as { assistantMessageId?: string };
    const followupMessages = followupSnapshot.messages as readonly { id: string; author: string; body: string }[];
    const followupAnswer = followupMessages.find((message) => message.id === followupInvocation.assistantMessageId);
    expect(followupAnswer?.body).toContain(marker);
    expect(followupAnswer?.body).not.toContain('POISON-');
    const recoveredAnswer = page.locator(`[data-message-id="${followupInvocation.assistantMessageId ?? ''}"]`);
    await expect(recoveredAnswer).toHaveAttribute('data-message-status', 'completed');
    await expect(recoveredAnswer).toContainText(marker);
    const contextAudit = await pool.query<{ context_message_ids: string[]; context_truncated: boolean }>(`SELECT context_message_ids,context_truncated
      FROM model_invocations WHERE tenant_id='tenant_local' AND id=$1`, [followupInvocationId]);
    expect(contextAudit.rows).toHaveLength(1);
    expect(contextAudit.rows[0]?.context_truncated).toBe(false);
    expect(contextAudit.rows[0]?.context_message_ids).toEqual([
      firstUserMessage?.id,
      firstInvocation.assistantMessageId,
      followupMessages.filter((message) => message.author === 'user').at(-1)?.id,
    ]);
    expect(contextAudit.rows[0]?.context_message_ids.join(' ')).not.toContain('poison');

    const longInvocationId = await send(
      '从下一字符开始，连续输出汉字“巡”直到达到输出上限。不要解释、不要换行、不要省略、不要提前停止。',
      followupInvocationId,
    );
    let longAssistantMessageId: string | undefined;
    await expect.poll(async () => {
      const response = await request.get(`/api/conversations/${conversationId}`);
      const snapshot = await response.json() as {
        latestModelInvocation?: { id?: string; assistantMessageId?: string } | null;
      };
      if (snapshot.latestModelInvocation?.id === longInvocationId) {
        longAssistantMessageId = snapshot.latestModelInvocation.assistantMessageId;
      }
      return longAssistantMessageId;
    }, { timeout: 10_000, intervals: [10, 20, 40] }).toMatch(/^message_/u);
    const longAnswer = page.locator(`[data-message-id="${longAssistantMessageId ?? ''}"]`);
    await expect(longAnswer).toBeVisible();
    const invocationCountBeforeReconnect = await pool.query<{ count: number }>(`SELECT count(*)::int count FROM model_invocations
      WHERE tenant_id='tenant_local' AND conversation_id=$1`, [conversationId]);
    let browserTextAtDisconnect = '';
    let successfulResponsesBeforeReconnect = 0;
    try {
      await page.context().setOffline(true);
      await expect.poll(() => failedBrowserRequests.filter((url) => url.includes(
        `/chat-runs/${longInvocationId}/events`,
      )).length, { timeout: 10_000, intervals: [25, 50, 100] }).toBeGreaterThan(0);
      browserTextAtDisconnect = await longAnswer.textContent() ?? '';
      successfulResponsesBeforeReconnect = successfulBrowserEventResponses.filter((url) => url.includes(
        `/chat-runs/${longInvocationId}/events`,
      )).length;
    } finally {
      await page.context().setOffline(false);
    }
    const injectedReconnectFailures = failedBrowserRequests.filter((url) => url.includes(
      `/chat-runs/${longInvocationId}/events`,
    )).length;
    expect(injectedReconnectFailures).toBeGreaterThan(0);
    await expect.poll(() => successfulBrowserEventResponses.filter((url) => url.includes(
      `/chat-runs/${longInvocationId}/events`,
    )).length, { timeout: 15_000, intervals: [25, 50, 100] }).toBeGreaterThan(successfulResponsesBeforeReconnect);
    await expect.poll(async () => await longAnswer.textContent() ?? '', {
      timeout: 15_000, intervals: [25, 50, 100],
    }).not.toBe(browserTextAtDisconnect);
    await expect(longAnswer.locator('p')).not.toBeEmpty();
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
    await expect(page.getByTestId('stop-generation')).toBeVisible();
    await page.getByTestId('stop-generation').click();
    const canceledSnapshot = await waitForStatus(longInvocationId, 'canceled') as {
      latestModelInvocation?: { status?: string } | null;
      messages?: readonly { id?: string; author?: string; body?: string; status?: string }[];
    };
    const canceledAssistant = canceledSnapshot.messages?.at(-1);
    expect(canceledAssistant).toMatchObject({ author: 'xiaowei', status: 'canceled' });
    expect(canceledAssistant?.body?.length).toBeGreaterThan(0);
    const events = await request.get(`/api/conversations/${conversationId}/chat-runs/${longInvocationId}/events?cursor=0`, {
      headers: { accept: 'text/event-stream' },
    });
    const eventStream = await events.text();
    expect(eventStream).toContain('event: run.canceled');
    expect(eventStream).not.toContain('event: message.completed');
    await new Promise((resolve) => setTimeout(resolve, 750));
    const terminal = await pool.query<{ invocation_status: string; dispatch_status: string; message_status: string; execution_fence: string; completed_audits: number }>(`SELECT
      invocation.status invocation_status,dispatch.status dispatch_status,message.status message_status,
      invocation.execution_fence::text,
      (SELECT count(*)::int FROM model_gateway_audit audit WHERE audit.tenant_id=invocation.tenant_id
        AND audit.model_invocation_id=invocation.id AND audit.outcome='completed') completed_audits
      FROM model_invocations invocation
      JOIN chat_turn_dispatches dispatch ON dispatch.tenant_id=invocation.tenant_id AND dispatch.model_invocation_id=invocation.id
      JOIN messages message ON message.tenant_id=invocation.tenant_id AND message.id=invocation.assistant_message_id
      WHERE invocation.tenant_id='tenant_local' AND invocation.id=$1`, [longInvocationId]);
    expect(terminal.rows).toEqual([{
      invocation_status: 'canceled', dispatch_status: 'canceled', message_status: 'canceled', execution_fence: '2', completed_audits: 0,
    }]);
    await page.reload();
    await expect(page.locator(`[data-message-id="${canceledAssistant?.id ?? ''}"]`)).toHaveAttribute('data-message-status', 'canceled');
    await expect(page.getByTestId('stop-generation')).toHaveCount(0);

    const createInterruptedRun = async (key: string): Promise<string> => {
      const response = await request.post(`/api/conversations/${conversationId}/chat-runs`, {
        headers: { 'idempotency-key': key },
        data: {
          capabilityId: 'xiaowei.chat.v1', clientMessageId: `client-${key}`,
          content: '从下一字符开始，连续输出汉字“检”直到达到输出上限。不要解释、不要换行、不要省略、不要提前停止。',
        },
      });
      const responseBody = await response.json() as { modelInvocationId?: string; error?: unknown };
      expect(response.status(), JSON.stringify(responseBody)).toBe(202);
      expect(responseBody.modelInvocationId).toMatch(/^model_invocation_/u);
      const invocationId = responseBody.modelInvocationId;
      if (invocationId === undefined) throw new Error('Interrupted run did not expose a ModelInvocation ID');
      await expect.poll(async () => {
        const invocation = await pool.query<{ status: string }>(`SELECT status FROM model_invocations
          WHERE tenant_id='tenant_local' AND id=$1`, [invocationId]);
        return invocation.rows[0]?.status ?? null;
      }, { timeout: 30_000, intervals: [10, 20, 40] }).toBe('running');
      return invocationId;
    };
    const expireAndAwaitSnapshot = async (invocationId: string): Promise<void> => {
      await pool.query(`UPDATE chat_turn_dispatches SET deadline=now()-interval '1 second',lease_until=now()-interval '1 second'
        WHERE tenant_id='tenant_local' AND model_invocation_id=$1`, [invocationId]);
      await pool.query(`UPDATE model_invocations SET deadline=now()-interval '1 second'
        WHERE tenant_id='tenant_local' AND id=$1`, [invocationId]);
      await expect.poll(async () => {
        const snapshot = await request.get(`/api/conversations/${conversationId}`);
        const invocation = (await snapshot.json() as { latestModelInvocation?: { id?: string; status?: string; errorClass?: string } | null })
          .latestModelInvocation;
        return invocation?.id === invocationId ? `${invocation.status}:${invocation.errorClass ?? ''}` : null;
      }, { timeout: 5_000, intervals: [20, 40, 80] }).toBe('failed:MODEL_STREAM_INTERRUPTED');
      const failureEvents = await request.get(`/api/conversations/${conversationId}/chat-runs/${invocationId}/events?cursor=0`);
      expect(await failureEvents.text()).toContain('MODEL_STREAM_INTERRUPTED');
    };

    const workerInterruptedInvocationId = await createInterruptedRun(`a02-worker-exit-${runId}`);
    const workerIdentity = JSON.parse(await readFile(
      `/tmp/geneway-runs/${runId}/process-boundaries/worker.json`, 'utf8',
    )) as ProcessIdentity;
    const workerKilled = await supervisorRequest<{ restartScheduled: boolean }>(workerHealthPort, '/test/kill-worker', {
      ...workerIdentity, restart: false,
    });
    expect(workerKilled).toMatchObject({ status: 202, body: { restartScheduled: false } });
    await expireAndAwaitSnapshot(workerInterruptedInvocationId);
    const workerResumed = await supervisorRequest<{ restartScheduled: boolean }>(workerHealthPort, '/test/resume-worker', {});
    expect(workerResumed).toMatchObject({ status: 202, body: { restartScheduled: true } });
    await waitSupervisorReady(workerHealthPort);

    const gatewayInterruptedInvocationId = await createInterruptedRun(`a02-gateway-exit-${runId}`);
    const gatewayIdentity = JSON.parse(await readFile(
      `/tmp/geneway-runs/${runId}/process-boundaries/model-gateway.json`, 'utf8',
    )) as ProcessIdentity;
    const gatewayKilled = await supervisorRequest<{ restartScheduled: boolean }>(
      modelGatewaySupervisorPort, '/test/kill-model-gateway', { ...gatewayIdentity, restart: false },
    );
    expect(gatewayKilled).toMatchObject({ status: 202, body: { restartScheduled: false } });
    await expireAndAwaitSnapshot(gatewayInterruptedInvocationId);
    const gatewayResumed = await supervisorRequest<{ restartScheduled: boolean }>(
      modelGatewaySupervisorPort, '/test/resume-model-gateway', {},
    );
    expect(gatewayResumed).toMatchObject({ status: 202, body: { restartScheduled: true } });
    await waitSupervisorReady(modelGatewaySupervisorPort);

    const finalPublicSnapshot = await request.get(`/api/conversations/${conversationId}`);
    const publicSurface = `${await page.content()}\n${await finalPublicSnapshot.text()}\n${eventStream}`;
    const forbiddenMarkers = [
      secretCanary,
      ['/home/gewu/.codex', 'auth.json'].join('/'),
      ['GENEWAY_CODEX', 'SUBSCRIPTION_AUTH_FILE'].join('_'),
      'GENEWAY_E2E_SECRET_CANARY',
      'access_token',
      'refresh_token',
    ];
    for (const forbidden of forbiddenMarkers) {
      if (publicSurface.includes(forbidden)) throw new Error('Browser public boundary exposed forbidden credential material');
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
    await pool.end();
  }
});
