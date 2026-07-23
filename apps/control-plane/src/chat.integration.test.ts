import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from './index.js';
import { CapabilityReleaseRepository } from './capability-release.js';
import type { ChatTurnClaim } from './chat-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for chat integration tests');

const originHeaders = (key: string) => ({ origin: 'http://localhost:3200', 'idempotency-key': key });
const invocationSecret = 'chat-invocation-secret-00000000000000000000000001';
const completedReceipt = (claim: ChatTurnClaim, overrides: Readonly<Record<string, unknown>> = {}) => {
  const payload = {
    schemaVersion: 'model-gateway-receipt/1' as const,
    issuer: 'geneway-model-gateway' as const,
    audience: 'geneway-control-plane' as const,
    receiptJti: randomUUID(),
    conversationId: claim.conversationId,
    modelInvocationId: claim.modelInvocationId,
    fence: claim.fence,
    issuedAt: new Date().toISOString(),
    outcome: 'completed' as const,
    providerRevision: '@openai-oauth/ai-sdk@2.0.0',
    modelRevision: 'gpt-5.4-mini',
    usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18, pricing: 'unpriced' },
    ...overrides,
  };
  return { payload, signature: createHmac('sha256', invocationSecret).update(JSON.stringify(payload), 'utf8').digest('base64url') };
};
const providerEvidence = (seed: string) => ({
  kind: 'provider-readiness' as const,
  manifestDigest: seed.repeat(64),
  conformanceDigest: seed.repeat(64),
  profile: 'codex_subscription_dev' as const,
  providerModel: 'gpt-5.4-mini' as const,
  conformancePassedAt: new Date(Date.now() - 1_000).toISOString(),
  conformanceDeadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  conformanceExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  credentialBoundary: 'manifest-bound-owner-0700-or-authorized-0775-parent-0600-file-v1' as const,
});
const candidateEvidence = (seed: string, shadowEvidenceDigest: string) => ({
  kind: 'disposable-live-validation-candidate' as const,
  runId: 'integration-chat',
  manifestDigest: seed.repeat(64),
  conformanceDigest: seed.repeat(64),
  shadowEvidenceDigest,
  purpose: 'temporarily open the disposable route solely for gate-a0-live validation' as const,
  expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
});

describe('Gate A0 task-free chat authority', () => {
  let controlPlane: ControlPlane;

  beforeAll(async () => {
    controlPlane = await createControlPlane({
      databaseUrl, objectStorage: null, chatRouteAvailable: () => Promise.resolve(true), liveValidationRunId: 'integration-chat',
    });
    return async () => controlPlane.app.close();
  });

  beforeEach(async () => controlPlane.repository.resetForTest());

  it('creates one task-free invocation, persists live deltas, and replays idempotently', async () => {
    const releases = new CapabilityReleaseRepository(controlPlane.repository.pool);
    const shadow = await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'shadow',
      expectedReleaseId: 'release_xiaowei_chat_v1_draft', expectedPointerVersion: 1,
      actor: 'integration-test', evidence: providerEvidence('1'),
    });
    await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
      expectedReleaseId: shadow.releaseId, expectedPointerVersion: shadow.pointerVersion,
      actor: 'integration-test', evidence: candidateEvidence('1', shadow.gateEvidenceDigest),
    });
    const conversationResponse = await controlPlane.app.inject({
      method: 'POST', url: '/api/conversations', headers: originHeaders('a0-conversation-0001'),
    });
    const conversationId = conversationResponse.json<{ id: string }>().id;
    const payload = { capabilityId: 'xiaowei.chat.v1', content: '  Cafe\u0301，请介绍你能做什么  ', clientMessageId: 'client-message-1' };
    const created = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs`,
      headers: originHeaders('a0-chat-run-0000001'), payload: { ...payload, tenantId: 'forged', provider: 'forged' },
    });
    expect(created.statusCode, created.body).toBe(202);
    const run = created.json<{
      conversationId: string; userMessageId: string; assistantMessageId: string; modelInvocationId: string; status: string;
    }>();
    expect(run).toMatchObject({ conversationId, status: 'pending' });
    const replay = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs`, headers: originHeaders('a0-chat-run-0000001'), payload,
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({ modelInvocationId: run.modelInvocationId, userMessageId: run.userMessageId });
    const transportReplay = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs`, headers: originHeaders('a0-chat-run-0000001'),
      payload: { ...payload, content: 'Café，请介绍你能做什么', clientMessageId: 'different-transport-correlation' },
    });
    expect(transportReplay.statusCode, transportReplay.body).toBe(202);
    expect(transportReplay.json()).toMatchObject({ modelInvocationId: run.modelInvocationId, userMessageId: run.userMessageId });
    const conflict = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs`, headers: originHeaders('a0-chat-run-0000001'),
      payload: { ...payload, content: 'different' },
    });
    expect(conflict.statusCode).toBe(409);

    const claim = await controlPlane.chatRepository.claimChatTurn('worker-a0-1', invocationSecret, 60_000);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error('Expected a chat claim');
    await controlPlane.chatRepository.chatStarted(claim);
    await expect(controlPlane.chatRepository.consumeInvocationToken(claim.invocationToken, invocationSecret)).resolves.toBe(true);
    await expect(controlPlane.chatRepository.consumeInvocationToken(claim.invocationToken, invocationSecret)).resolves.toBe(false);
    await controlPlane.chatRepository.chatDelta(claim, '你好，');
    await controlPlane.chatRepository.chatDelta(claim, '我是小纬。');
    await controlPlane.chatRepository.chatCompleted(claim, completedReceipt(claim), invocationSecret);

    const otherConversation = await controlPlane.app.inject({
      method: 'POST', url: '/api/conversations', headers: originHeaders('a0-conversation-0002'),
    });
    const otherConversationId = otherConversation.json<{ id: string }>().id;
    const sameKeyOtherConversation = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${otherConversationId}/chat-runs`, headers: originHeaders('a0-chat-run-0000001'), payload,
    });
    expect(sameKeyOtherConversation.statusCode, sameKeyOtherConversation.body).toBe(202);
    expect(sameKeyOtherConversation.json<{ modelInvocationId: string }>().modelInvocationId).not.toBe(run.modelInvocationId);

    const snapshot = await controlPlane.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json()).toMatchObject({
      latestTaskId: null,
      latestModelInvocation: { id: run.modelInvocationId, status: 'completed' },
      messages: [
        { id: run.userMessageId, author: 'user', status: 'completed' },
        { id: run.assistantMessageId, author: 'xiaowei', body: '你好，我是小纬。', status: 'completed' },
      ],
    });
    const events = await controlPlane.app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/chat-runs/${run.modelInvocationId}/events?cursor=0`,
      headers: { accept: 'text/event-stream' },
    });
    expect(events.statusCode, events.body).toBe(200);
    expect(events.body).toContain('event: run.started');
    expect(events.body).toContain('event: message.delta');
    expect(events.body).toContain('event: message.completed');
    const attestation = await controlPlane.repository.pool.query<{
      attested: boolean; receipt_digest: string; gateway_receipt_jti: string; consumed_tokens: number;
    }>(`SELECT audit.attested,audit.receipt_digest,audit.gateway_receipt_jti,
      (SELECT count(*)::int FROM model_invocation_token_authorizations token
        WHERE token.tenant_id=audit.tenant_id AND token.model_invocation_id=audit.model_invocation_id
          AND token.consumed_at IS NOT NULL) consumed_tokens
      FROM model_gateway_audit audit WHERE audit.tenant_id='tenant_local' AND audit.model_invocation_id=$1`, [run.modelInvocationId]);
    expect(attestation.rows).toHaveLength(1);
    expect(attestation.rows[0]?.attested).toBe(true);
    expect(attestation.rows[0]?.receipt_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.rows[0]?.gateway_receipt_jti).toMatch(/^[0-9a-f-]{36}$/u);
    expect(attestation.rows[0]?.consumed_tokens).toBe(1);
    const forbiddenCounts = await controlPlane.repository.pool.query(`SELECT
      (SELECT count(*)::int FROM business_tasks) business_tasks,
      (SELECT count(*)::int FROM workflow_versions) workflows,
      (SELECT count(*)::int FROM evidence_items) evidence,
      (SELECT count(*)::int FROM artifacts) artifacts`);
    expect(forbiddenCounts.rows[0]).toEqual({ business_tasks: 0, workflows: 0, evidence: 0, artifacts: 0 });
  });

  it('fails closed before creating messages when the live route is unavailable', async () => {
    const unavailable = await createControlPlane({ databaseUrl, objectStorage: null, chatRouteAvailable: () => Promise.resolve(false) });
    try {
      const conversation = await unavailable.app.inject({
        method: 'POST', url: '/api/conversations', headers: originHeaders('a0-unavailable-conversation'),
      });
      const conversationId = conversation.json<{ id: string }>().id;
      const response = await unavailable.app.inject({
        method: 'POST', url: `/api/conversations/${conversationId}/chat-runs`, headers: originHeaders('a0-unavailable-run'),
        payload: { capabilityId: 'xiaowei.chat.v1', content: 'hello', clientMessageId: 'client-unavailable' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'MODEL_ROUTE_UNAVAILABLE' } });
      const count = await unavailable.repository.pool.query<{ count: string }>('SELECT count(*)::text count FROM model_invocations');
      expect(count.rows[0]?.count).toBe('0');
    } finally {
      await unavailable.app.close();
    }
  });

  it('keeps a started chat attempt valid past its short claim lease until the invocation deadline', async () => {
    const releases = new CapabilityReleaseRepository(controlPlane.repository.pool);
    const shadow = await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'shadow',
      expectedReleaseId: 'release_xiaowei_chat_v1_draft', expectedPointerVersion: 1,
      actor: 'integration-test', evidence: providerEvidence('3'),
    });
    await releases.promote({
      tenantId: 'tenant_local', capabilityId: 'xiaowei.chat.v1', targetState: 'internal',
      expectedReleaseId: shadow.releaseId, expectedPointerVersion: shadow.pointerVersion,
      actor: 'integration-test', evidence: candidateEvidence('3', shadow.gateEvidenceDigest),
    });
    const conversationResponse = await controlPlane.app.inject({
      method: 'POST', url: '/api/conversations', headers: originHeaders('a0-long-stream-conversation'),
    });
    const conversationId = conversationResponse.json<{ id: string }>().id;
    const created = await controlPlane.app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/chat-runs`, headers: originHeaders('a0-long-stream-run'),
      payload: { capabilityId: 'xiaowei.chat.v1', content: '请给出一个真实首轮回答', clientMessageId: 'client-long-stream' },
    });
    expect(created.statusCode, created.body).toBe(202);
    const claim = await controlPlane.chatRepository.claimChatTurn('worker-long-stream', invocationSecret, 1_000);
    expect(claim).not.toBeNull();
    if (claim === null) throw new Error('Expected a chat claim');
    await controlPlane.chatRepository.chatStarted(claim);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(controlPlane.chatRepository.chatDelta(claim, '超过短 claim lease 后仍有效。')).resolves.toBeUndefined();
    await expect(controlPlane.chatRepository.chatCompleted(
      claim,
      completedReceipt(claim, { conversationId: 'another-conversation' }),
      invocationSecret,
    )).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED' });
    await expect(controlPlane.chatRepository.chatCompleted(claim, completedReceipt(claim), invocationSecret)).resolves.toBeUndefined();
    const dispatch = await controlPlane.repository.pool.query<{ status: string; lease_until: Date | null; deadline: Date }>(`SELECT status,lease_until,deadline
      FROM chat_turn_dispatches WHERE tenant_id='tenant_local' AND id=$1`, [claim.dispatchId]);
    expect(dispatch.rows[0]).toMatchObject({ status: 'completed', lease_until: null });
    expect(new Date(claim.deadline).getTime()).toBe(dispatch.rows[0]?.deadline.getTime());
  });
});
