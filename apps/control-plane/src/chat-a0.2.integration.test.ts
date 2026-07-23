import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from './index.js';
import { CapabilityReleaseRepository } from './capability-release.js';
import type { ChatErrorClass } from '@geneway/contracts';
import type { ChatTurnClaim } from './chat-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for Gate A0.2 integration tests');

const invocationSecret = 'chat-a0.2-invocation-secret-0000000000000000001';
const headers = (key: string) => ({
  origin: 'http://localhost:3200',
  'idempotency-key': key,
  forwarded: 'for=203.0.113.7;host=attacker.invalid',
  'x-forwarded-for': '203.0.113.8',
  'x-geneway-tenant': 'tenant_forged',
  'x-geneway-principal': 'user_forged',
});

const receipt = (claim: ChatTurnClaim, outcome: 'completed' | ChatErrorClass, retryNotBefore?: string) => {
  const payload = outcome === 'completed' ? {
    schemaVersion: 'model-gateway-receipt/1' as const,
    issuer: 'geneway-model-gateway' as const,
    audience: 'geneway-control-plane' as const,
    receiptJti: randomUUID(),
    conversationId: claim.conversationId,
    modelInvocationId: claim.modelInvocationId,
    fence: claim.fence,
    issuedAt: new Date().toISOString(),
    outcome,
    providerRevision: 'test-provider/1',
    modelRevision: 'test-model/1',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, pricing: 'unpriced' },
  } : {
    schemaVersion: 'model-gateway-receipt/1' as const,
    issuer: 'geneway-model-gateway' as const,
    audience: 'geneway-control-plane' as const,
    receiptJti: randomUUID(),
    conversationId: claim.conversationId,
    modelInvocationId: claim.modelInvocationId,
    fence: claim.fence,
    issuedAt: new Date().toISOString(),
    outcome,
    providerRevision: 'test-provider/1',
    modelRevision: 'test-model/1',
    usage: null,
    ...(retryNotBefore === undefined ? {} : { retryNotBefore }),
  };
  return { payload, signature: createHmac('sha256', invocationSecret).update(JSON.stringify(payload), 'utf8').digest('base64url') };
};

describe('Gate A0.2 context, cancellation, failure and cursor authority', () => {
  let controlPlane: ControlPlane;

  beforeAll(async () => {
    controlPlane = await createControlPlane({
      databaseUrl, objectStorage: null, chatRouteAvailable: () => Promise.resolve(true), liveValidationRunId: 'integration-chat-a0.2',
      chatReaperIntervalMs: 20,
    });
    return async () => controlPlane.app.close();
  });

  beforeEach(async () => {
    await controlPlane.repository.resetForTest();
    const releases = new CapabilityReleaseRepository(controlPlane.repository.pool);
    const providerEvidence = {
      kind: 'provider-readiness' as const,
      manifestDigest: '4'.repeat(64),
      conformanceDigest: '5'.repeat(64),
      profile: 'codex_subscription_dev' as const,
      providerModel: 'gpt-5.4-mini' as const,
      conformancePassedAt: new Date(Date.now() - 1_000).toISOString(),
      conformanceDeadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      conformanceExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      credentialBoundary: 'manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1' as const,
    };
    const shadow = await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'shadow',
      expectedReleaseId: 'release_xiaowei_chat_v1_draft', expectedPointerVersion: 1,
      actor: 'a0.2-integration', evidence: providerEvidence,
    });
    await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
      expectedReleaseId: shadow.releaseId, expectedPointerVersion: shadow.pointerVersion,
      actor: 'a0.2-integration', evidence: {
        kind: 'disposable-live-validation-candidate' as const,
        runId: 'integration-chat-a0.2',
        manifestDigest: providerEvidence.manifestDigest,
        conformanceDigest: providerEvidence.conformanceDigest,
        shadowEvidenceDigest: shadow.gateEvidenceDigest,
        purpose: 'temporarily open the disposable route solely for gate-a0-live validation' as const,
        expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      },
    });
  });

  async function createConversation(key: string): Promise<string> {
    const response = await controlPlane.app.inject({ method: 'POST', url: '/api/conversations', headers: headers(key) });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function createRun(conversationId: string, key: string, content = '当前问题'): Promise<{
    modelInvocationId: string; assistantMessageId: string; userMessageId: string;
  }> {
    const response = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs`, headers: headers(key),
      payload: {
        capabilityId: 'xiaowei.chat.v1', content, clientMessageId: `client-${key}`,
        tenantId: 'tenant_forged', principalId: 'user_forged', routeProfile: 'forged', dataClass: 'C3',
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json();
  }

  it('builds a normalized complete-turn 24-message/64-KiB window from only the current Conversation', async () => {
    const conversationId = await createConversation('a02-context-conversation');
    const unrelatedConversationId = await createConversation('a02-context-unrelated');
    await controlPlane.repository.pool.query(`INSERT INTO messages
      (tenant_id,id,conversation_id,author,body,status,content_version,completed_at)
      VALUES ('tenant_local','poison_user',$1,'user','POISON-CROSS-CONVERSATION','completed',1,now()),
             ('tenant_local','poison_assistant',$1,'xiaowei','POISON-ANSWER','completed',1,now())`, [unrelatedConversationId]);
    for (let turn = 0; turn < 13; turn += 1) {
      await controlPlane.repository.pool.query(`INSERT INTO messages
        (tenant_id,id,conversation_id,author,body,status,content_version,completed_at)
        VALUES ('tenant_local',$2,$1,'user',$4,'completed',1,now()),
               ('tenant_local',$3,$1,'xiaowei',$5,'completed',1,now())`, [
        conversationId, `context_user_${String(turn)}`, `context_assistant_${String(turn)}`,
        `${String(turn)}-Cafe\u0301-${'u'.repeat(3_980)}`, `${String(turn)}-${'a'.repeat(3_988)}`,
      ]);
    }
    await controlPlane.repository.pool.query(`INSERT INTO messages
      (tenant_id,id,conversation_id,author,body,status,content_version,completed_at)
      VALUES ('tenant_local','context_failed_user',$1,'user','failed-turn-user','completed',1,now()),
             ('tenant_local','context_failed_assistant',$1,'xiaowei','must-not-enter','failed',1,now()),
             ('tenant_local','context_canceled_user',$1,'user','canceled-turn-user','completed',1,now()),
             ('tenant_local','context_canceled_assistant',$1,'xiaowei','must-not-enter','canceled',1,now()),
             ('tenant_local','context_streaming_user',$1,'user','streaming-turn-user','completed',1,now()),
             ('tenant_local','context_streaming_assistant',$1,'xiaowei','must-not-enter','streaming',1,NULL)`, [conversationId]);

    const run = await createRun(conversationId, 'a02-context-run', '末轮 Cafe\u0301');
    const claim = await controlPlane.chatRepository.claimChatTurn('worker-a0.2-context', invocationSecret, 60_000);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error('Expected context claim');
    const contextIds = claim.context.map((message) => message.messageId);
    expect(claim.contextTruncated).toBe(true);
    expect(claim.context.length).toBeLessThanOrEqual(24);
    expect(claim.context[0]?.author).toBe('user');
    expect(claim.context.at(-1)).toMatchObject({ messageId: run.userMessageId, content: '末轮 Café' });
    expect(claim.context.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0)).toBeLessThanOrEqual(64 * 1024);
    expect(contextIds).not.toEqual(expect.arrayContaining([
      'poison_user', 'poison_assistant',
      'context_failed_user', 'context_failed_assistant',
      'context_canceled_user', 'context_canceled_assistant',
      'context_streaming_user', 'context_streaming_assistant',
    ]));
    for (let index = 0; index < claim.context.length; index += 1) {
      if (claim.context[index]?.author === 'xiaowei') expect(claim.context[index - 1]?.author).toBe('user');
    }
    const audit = await controlPlane.repository.pool.query<{
      context_message_ids: string[]; context_truncated: boolean; requester_id: string; tenant_id: string;
    }>(`SELECT context_message_ids,context_truncated,requester_id,tenant_id FROM model_invocations
      WHERE tenant_id='tenant_local' AND id=$1`, [run.modelInvocationId]);
    expect(audit.rows).toEqual([{
      context_message_ids: contextIds, context_truncated: true, requester_id: 'user_local', tenant_id: 'tenant_local',
    }]);
  });

  it('increments the fence on cancel, aborts authority, freezes the partial checkpoint and rejects late completion', async () => {
    const conversationId = await createConversation('a02-cancel-conversation');
    const run = await createRun(conversationId, 'a02-cancel-run', '请给出较长回答');
    const claim = await controlPlane.chatRepository.claimChatTurn('worker-a0.2-cancel', invocationSecret, 60_000);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error('Expected cancellation claim');
    await controlPlane.chatRepository.chatStarted(claim);
    await expect(controlPlane.chatRepository.consumeInvocationToken(claim.invocationToken, invocationSecret)).resolves.toBe(true);
    await controlPlane.chatRepository.chatDelta(claim, '已持久化的部分回答');

    const canceled = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs/${run.modelInvocationId}/cancel`,
      headers: headers('a02-cancel-request'),
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json()).toMatchObject({ modelInvocationId: run.modelInvocationId, status: 'cancel_requested' });
    await expect(controlPlane.chatRepository.consumeInvocationToken(claim.invocationToken, invocationSecret)).resolves.toBe(false);
    await expect(controlPlane.chatRepository.chatDelta(claim, '迟到增量')).rejects.toMatchObject({ code: 'STALE_CHAT_ATTEMPT' });
    await expect(controlPlane.chatRepository.chatCompleted(claim, receipt(claim, 'completed'), invocationSecret))
      .rejects.toMatchObject({ code: 'STALE_CHAT_ATTEMPT' });
    const cancelFence = await controlPlane.chatRepository.requestedCancellationFence(claim);
    expect(cancelFence).toBe(claim.fence + 1);
    await controlPlane.chatRepository.chatCanceled({ ...claim, fence: cancelFence ?? 0 });

    const replay = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs/${run.modelInvocationId}/cancel`,
      headers: headers('a02-cancel-replay'),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'canceled' });
    const snapshot = await controlPlane.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    const snapshotBody = snapshot.json<{
      latestModelInvocation: { id: string; status: string } | null;
      messages: readonly { id: string; body: string; status: string }[];
    }>();
    expect(snapshotBody).toMatchObject({
      latestModelInvocation: { id: run.modelInvocationId, status: 'canceled' },
    });
    expect(snapshotBody.messages.some((message) => message.id === run.assistantMessageId
      && message.body === '已持久化的部分回答' && message.status === 'canceled')).toBe(true);
    const terminalEvents = await controlPlane.app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/chat-runs/${run.modelInvocationId}/events?cursor=0`,
      headers: { accept: 'text/event-stream' },
    });
    expect(terminalEvents.body.match(/event: run\.canceled/gu)).toHaveLength(1);
    expect(terminalEvents.body).not.toContain('event: message.completed');
    const audit = await controlPlane.repository.pool.query<{ completed: string }>(`SELECT count(*)::text completed
      FROM model_gateway_audit WHERE tenant_id='tenant_local' AND model_invocation_id=$1 AND outcome='completed'`, [run.modelInvocationId]);
    expect(audit.rows[0]?.completed).toBe('0');
  });

  it('maps quota, timeout and stream failure to immutable public terminals and reaps expired work', async () => {
    const failures: readonly ChatErrorClass[] = ['MODEL_AUTH_FAILED', 'MODEL_QUOTA', 'MODEL_TIMEOUT', 'MODEL_STREAM_INTERRUPTED', 'MODEL_PROTOCOL_VIOLATION'];
    for (const [index, errorClass] of failures.entries()) {
      const conversationId = await createConversation(`a02-failure-conversation-${String(index)}`);
      const run = await createRun(conversationId, `a02-failure-run-${String(index)}`);
      const claim = await controlPlane.chatRepository.claimChatTurn(`worker-a0.2-failure-${String(index)}`, invocationSecret, 60_000);
      expect(claim).not.toBeNull();
      if (claim === null) throw new Error('Expected failure claim');
      await controlPlane.chatRepository.chatStarted(claim);
      const retryNotBefore = errorClass === 'MODEL_QUOTA' ? new Date(Date.now() + 60_000).toISOString() : undefined;
      await controlPlane.chatRepository.chatFailed(claim, receipt(claim, errorClass, retryNotBefore), invocationSecret);
      const snapshot = await controlPlane.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
      expect(snapshot.json()).toMatchObject({ latestModelInvocation: { status: 'failed', errorClass } });
      const events = await controlPlane.app.inject({
        method: 'GET', url: `/api/conversations/${conversationId}/chat-runs/${run.modelInvocationId}/events?cursor=0`,
      });
      const eventList = events.json<{ events: readonly { eventType: string; errorClass?: string; retryNotBefore?: string }[] }>().events;
      expect(eventList.some((event) => event.eventType === 'run.failed' && event.errorClass === errorClass
        && (retryNotBefore === undefined || event.retryNotBefore === retryNotBefore))).toBe(true);
      await expect(controlPlane.chatRepository.chatCompleted(claim, receipt(claim, 'completed'), invocationSecret))
        .rejects.toMatchObject({ code: 'STALE_CHAT_ATTEMPT' });
    }

    const expiredConversationId = await createConversation('a02-expired-conversation');
    const expiredRun = await createRun(expiredConversationId, 'a02-expired-run');
    const expiredClaim = await controlPlane.chatRepository.claimChatTurn('worker-a0.2-expired', invocationSecret, 60_000);
    expect(expiredClaim).not.toBeNull();
    if (expiredClaim === null) throw new Error('Expected expiring claim');
    await controlPlane.chatRepository.chatStarted(expiredClaim);
    await controlPlane.repository.pool.query(`UPDATE chat_turn_dispatches SET deadline=now()-interval '1 second',lease_until=now()-interval '1 second'
      WHERE tenant_id='tenant_local' AND id=$1`, [expiredClaim.dispatchId]);
    await controlPlane.repository.pool.query(`UPDATE model_invocations SET deadline=now()-interval '1 second'
      WHERE tenant_id='tenant_local' AND id=$1`, [expiredRun.modelInvocationId]);
    await expect.poll(async () => {
      const expiredSnapshot = await controlPlane.app.inject({ method: 'GET', url: `/api/conversations/${expiredConversationId}` });
      return expiredSnapshot.json<{ latestModelInvocation: { status: string; errorClass: string | null } | null }>()
        .latestModelInvocation;
    }, { timeout: 2_000, interval: 20 }).toMatchObject({
      status: 'failed', errorClass: 'MODEL_STREAM_INTERRUPTED',
    });
    await expect(controlPlane.chatRepository.consumeInvocationToken(expiredClaim.invocationToken, invocationSecret)).resolves.toBe(false);
  });

  it('replays only cursor-greater committed SSE events and rejects mismatched authority', async () => {
    const conversationId = await createConversation('a02-cursor-conversation');
    const run = await createRun(conversationId, 'a02-cursor-run');
    const claim = await controlPlane.chatRepository.claimChatTurn('worker-a0.2-cursor', invocationSecret, 60_000);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error('Expected cursor claim');
    await controlPlane.chatRepository.chatStarted(claim);
    await controlPlane.chatRepository.chatDelta(claim, '一');
    await controlPlane.chatRepository.chatDelta(claim, '二');
    await controlPlane.chatRepository.chatCompleted(claim, receipt(claim, 'completed'), invocationSecret);
    const all = await controlPlane.chatRepository.getEvents({
      tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local',
    }, conversationId, run.modelInvocationId, 0);
    expect(all.length).toBeGreaterThanOrEqual(4);
    const cursor = all[1]?.cursor ?? 0;
    const replay = await controlPlane.app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/chat-runs/${run.modelInvocationId}/events?cursor=${String(cursor)}`,
      headers: { accept: 'text/event-stream' },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.body).not.toContain(`id: ${String(cursor)}\n`);
    for (const event of all.filter((candidate) => candidate.cursor > cursor)) {
      expect(replay.body).toContain(`id: ${String(event.cursor)}\nevent: ${event.eventType}\n`);
    }
    const otherConversationId = await createConversation('a02-cursor-other');
    const mismatched = await controlPlane.app.inject({
      method: 'GET', url: `/api/conversations/${otherConversationId}/chat-runs/${run.modelInvocationId}/events?cursor=0`,
    });
    expect(mismatched.statusCode).toBe(404);
    const invalid = await controlPlane.app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/chat-runs/${run.modelInvocationId}/events?cursor=-1`,
    });
    expect(invalid.statusCode).toBe(400);
  });
});
