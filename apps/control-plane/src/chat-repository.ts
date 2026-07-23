import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import {
  chatRunEventSchema,
  chatRunProjectionSchema,
  cancelChatRunProjectionSchema,
  conversationProjectionSchema,
  GenewayError,
  modelGatewayReceiptSchema,
  type ChatErrorClass,
  type ChatRunEvent,
  type ChatRunProjection,
  type CancelChatRunProjection,
  type ConversationProjection,
  type CreateChatRunInput,
  type ModelGatewayReceipt,
  type ModelGatewayReceiptPayload,
  type Principal,
} from '@geneway/contracts';

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const MAX_CONTEXT_MESSAGES = 24;
const MAX_CONTEXT_BYTES = 64 * 1024;

type InvocationRow = Readonly<{
  id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  status: 'pending' | 'running' | 'cancel_requested' | 'completed' | 'canceled' | 'failed';
  error_class: ChatErrorClass | null;
  last_event_cursor: string;
  created_at: Date;
  terminal_at: Date | null;
}>;

export type ChatTurnClaim = Readonly<{
  dispatchId: string;
  conversationId: string;
  modelInvocationId: string;
  assistantMessageId: string;
  attemptId: string;
  fence: number;
  deadline: string;
  invocationToken: string;
  logicalModelPolicy: 'general.chat.standard';
  promptPolicyVersion: 'xiaowei.chat.system/1';
  systemPrompt: string;
  context: readonly Readonly<{ messageId: string; author: 'user' | 'xiaowei'; content: string }>[];
  contextTruncated: boolean;
}>;

export type ChatWorkerMutation = Readonly<{
  dispatchId: string;
  modelInvocationId: string;
  attemptId: string;
  fence: number;
}>;

export type InvocationTokenClaims = Readonly<{
  iss: 'geneway-control-plane';
  aud: 'local-model-gateway';
  tenantId: string;
  principalId: string;
  conversationId: string;
  modelInvocationId: string;
  logicalModelPolicy: 'general.chat.standard';
  dataClass: 'C0';
  maxOutputTokens: number;
  deadline: string;
  fence: number;
  jti: string;
  iat: number;
  exp: number;
}>;

function encodeToken(claims: InvocationTokenClaims, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token: string, secret: string): InvocationTokenClaims {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) {
    throw new GenewayError('MODEL_AUTH_FAILED', 'Invocation token is invalid', 401);
  }
  const expectedSignature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new GenewayError('MODEL_AUTH_FAILED', 'Invocation token is invalid', 401);
  }
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as InvocationTokenClaims;
  if (claims.iss !== 'geneway-control-plane' || claims.aud !== 'local-model-gateway'
    || claims.logicalModelPolicy !== 'general.chat.standard' || claims.dataClass !== 'C0'
    || typeof claims.jti !== 'string' || typeof claims.exp !== 'number' || typeof claims.iat !== 'number'
    || claims.exp - claims.iat > 60 || claims.iat > Math.floor(Date.now() / 1_000) + 5
    || claims.exp < Math.floor(Date.now() / 1_000) - 5) {
    throw new GenewayError('MODEL_AUTH_FAILED', 'Invocation token is invalid or expired', 401);
  }
  return claims;
}

function requestDigest(input: CreateChatRunInput): string {
  return createHash('sha256').update(JSON.stringify({
    capabilityId: input.capabilityId,
    content: input.content,
  }), 'utf8').digest('hex');
}

export class ChatRepository {
  constructor(readonly pool: pg.Pool, private readonly liveValidationRunId?: string) {
    if (liveValidationRunId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(liveValidationRunId)) {
      throw new Error('Live validation run ID is invalid');
    }
  }

  async isInternalRelease(tenantId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM capability_active_releases active
      JOIN capability_release_records release ON release.tenant_id=active.tenant_id AND release.id=active.release_id
      JOIN capability_versions capability ON capability.tenant_id=release.tenant_id AND capability.id=release.capability_version_id
      JOIN prompt_policy_versions prompt ON prompt.tenant_id=release.tenant_id AND prompt.id=release.prompt_policy_version_id
      WHERE active.tenant_id=$1 AND active.capability_id='xiaowei.chat.v1' AND release.state='internal'
        AND CASE WHEN release.gate_evidence->>'kind'='disposable-live-validation-candidate'
          AND release.gate_evidence->>'expiresAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
          AND $2::text IS NOT NULL AND release.gate_evidence->>'runId'=$2
          THEN (release.gate_evidence->>'expiresAt')::timestamptz>now() ELSE false END
        AND capability.capability_id='xiaowei.chat.v1' AND capability.version=1
        AND prompt.policy_id='xiaowei.chat.system' AND prompt.version=1`, [tenantId, this.liveValidationRunId ?? null]);
    return result.rowCount === 1;
  }

  async assertInternalRelease(principal: Principal): Promise<void> {
    if (!await this.isInternalRelease(principal.tenantId)) {
      throw new GenewayError('MODEL_ROUTE_UNAVAILABLE', '真实模型通道未配置或不可用', 503);
    }
  }

  async createChatRun(
    principal: Principal,
    conversationId: string,
    input: CreateChatRunInput,
    idempotencyKey: string,
  ): Promise<ChatRunProjection> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new GenewayError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', 400);
    }
    const normalizedInput = { ...input, content: input.content.normalize('NFC').trim() };
    return this.withTransaction(async (client) => {
      await this.assertConversationOwned(client, principal, conversationId);
      const digest = requestDigest(normalizedInput);
      const replay = await client.query<{ request_digest: string; model_invocation_id: string }>(`SELECT request_digest,model_invocation_id
        FROM chat_idempotency_records WHERE tenant_id=$1 AND principal_id=$2 AND conversation_id=$3
          AND operation='chat-run.create' AND idempotency_key=$4 FOR UPDATE`, [
        principal.tenantId, principal.userId, conversationId, idempotencyKey,
      ]);
      if (replay.rows[0] !== undefined) {
        if (replay.rows[0].request_digest !== digest) {
          throw new GenewayError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with different chat content', 409);
        }
        return this.projectRun(client, principal, conversationId, replay.rows[0].model_invocation_id);
      }

      const active = await client.query(`SELECT 1 FROM model_invocations
        WHERE tenant_id=$1 AND status IN ('pending','running','cancel_requested') LIMIT 1 FOR UPDATE`, [principal.tenantId]);
      if (active.rowCount !== 0) throw new GenewayError('CHAT_BUSY', '真实模型通道正在处理另一条消息，请稍后重试', 409, { retryAfterMs: 1_000 });

      const userMessageId = id('message');
      const assistantMessageId = id('message');
      const invocationId = id('model_invocation');
      const dispatchId = id('chat_dispatch');
      const nextSequence = await client.query<{ sequence: string }>(`SELECT coalesce(max(sequence),0)+1::bigint sequence
        FROM messages WHERE tenant_id=$1 AND conversation_id=$2`, [principal.tenantId, conversationId]);
      const userSequence = Number(nextSequence.rows[0]?.sequence);
      await client.query(`INSERT INTO messages
        (tenant_id,id,conversation_id,sequence,author,body,status,content_version,completed_at)
        VALUES ($1,$2,$3,$4,'user',$5,'completed',1,now()),($1,$6,$3,$7,'xiaowei','','streaming',0,NULL)`, [
        principal.tenantId, userMessageId, conversationId, userSequence, normalizedInput.content, assistantMessageId, userSequence + 1,
      ]);
      await client.query(`INSERT INTO model_invocations
        (tenant_id,id,conversation_id,user_message_id,assistant_message_id,requester_id,
         capability_version_id,prompt_policy_version_id,logical_model_policy,route_profile,
         data_class,redaction_policy_version,budget,deadline,status)
        VALUES ($1,$2,$3,$4,$5,$6,'capability_xiaowei_chat_v1','prompt_xiaowei_chat_system_v1',
          'general.chat.standard','codex_subscription_dev','C0','chat-redaction/1',$7,now()+interval '2 minutes','pending')`, [
        principal.tenantId, invocationId, conversationId, userMessageId, assistantMessageId, principal.userId,
        { maxOutputTokens: 2_048, pricing: 'subscription_included/unpriced' },
      ]);
      await client.query(`INSERT INTO chat_turn_dispatches
        (tenant_id,id,principal_id,conversation_id,model_invocation_id,assistant_message_id,execution_fence,deadline,status)
        VALUES ($1,$2,$3,$4,$5,$6,1,now()+interval '2 minutes','pending')`, [
        principal.tenantId, dispatchId, principal.userId, conversationId, invocationId, assistantMessageId,
      ]);
      await client.query(`INSERT INTO chat_turn_outbox
        (tenant_id,id,dispatch_id,model_invocation_id,event_type)
        VALUES ($1,$2,$3,$4,'chat.turn.requested')`, [principal.tenantId, id('chat_outbox'), dispatchId, invocationId]);
      await client.query(`INSERT INTO chat_idempotency_records
        (tenant_id,principal_id,conversation_id,operation,idempotency_key,request_digest,model_invocation_id)
        VALUES ($1,$2,$3,'chat-run.create',$4,$5,$6)`, [
        principal.tenantId, principal.userId, conversationId, idempotencyKey, digest, invocationId,
      ]);
      return chatRunProjectionSchema.parse({
        conversationId,
        userMessageId,
        assistantMessageId,
        modelInvocationId: invocationId,
        eventCursor: 0,
        status: 'pending',
      });
    });
  }

  async getConversation(principal: Principal, conversationId: string): Promise<ConversationProjection> {
    return this.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const conversation = await client.query<{ id: string; created_at: Date }>(`SELECT id,created_at FROM conversations
        WHERE tenant_id=$1 AND id=$2 AND user_id=$3`, [principal.tenantId, conversationId, principal.userId]);
      const row = conversation.rows[0];
      if (row === undefined) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found', 404);
      const messages = await client.query<{
        id: string; author: 'user' | 'xiaowei'; body: string; status: 'completed' | 'streaming' | 'failed' | 'canceled';
        content_version: string; created_at: Date;
      }>(`SELECT id,author,body,status,content_version::text,created_at FROM messages
        WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY sequence`, [principal.tenantId, conversationId]);
      const latestTask = await client.query<{ id: string }>(`SELECT id FROM business_tasks
        WHERE tenant_id=$1 AND conversation_id=$2 AND requester_id=$3 ORDER BY updated_at DESC,id LIMIT 1`, [
        principal.tenantId, conversationId, principal.userId,
      ]);
      const invocation = await client.query<InvocationRow>(`SELECT id,conversation_id,user_message_id,assistant_message_id,status,error_class,
        last_event_cursor::text,created_at,terminal_at FROM model_invocations
        WHERE tenant_id=$1 AND conversation_id=$2 AND requester_id=$3 ORDER BY created_at DESC,id LIMIT 1`, [
        principal.tenantId, conversationId, principal.userId,
      ]);
      const latest = invocation.rows[0];
      const watermark = await client.query<{ cursor: string }>(`SELECT coalesce(max(cursor),0)::text cursor FROM chat_run_events
        WHERE tenant_id=$1 AND conversation_id=$2`, [principal.tenantId, conversationId]);
      return conversationProjectionSchema.parse({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        latestTaskId: latestTask.rows[0]?.id ?? null,
        messages: messages.rows.map((message) => ({
          id: message.id,
          author: message.author,
          body: message.body,
          status: message.status,
          contentVersion: Number(message.content_version),
          createdAt: message.created_at.toISOString(),
        })),
        latestModelInvocation: latest === undefined ? null : {
          id: latest.id,
          assistantMessageId: latest.assistant_message_id,
          status: latest.status,
          errorClass: latest.error_class,
          lastEventCursor: Number(latest.last_event_cursor),
          createdAt: latest.created_at.toISOString(),
          terminalAt: latest.terminal_at?.toISOString() ?? null,
        },
        eventWatermark: Number(watermark.rows[0]?.cursor ?? 0),
      });
    });
  }

  async getEvents(principal: Principal, conversationId: string, invocationId: string, cursor: number): Promise<readonly ChatRunEvent[]> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new GenewayError('INVALID_EVENT_CURSOR', 'Event cursor is invalid', 400);
    return this.withTransaction(async (client) => {
      await this.assertInvocationOwned(client, principal, conversationId, invocationId);
      const events = await client.query<{
        cursor: string; id: string; conversation_id: string; model_invocation_id: string; assistant_message_id: string;
        sequence: string; event_type: ChatRunEvent['eventType']; payload: Readonly<Record<string, unknown>>; occurred_at: Date;
      }>(`SELECT cursor::text,id,conversation_id,model_invocation_id,assistant_message_id,sequence::text,event_type,payload,occurred_at
        FROM chat_run_events WHERE tenant_id=$1 AND conversation_id=$2 AND model_invocation_id=$3 AND cursor>$4
        ORDER BY chat_run_events.cursor`, [principal.tenantId, conversationId, invocationId, cursor]);
      return events.rows.map((event) => chatRunEventSchema.parse({
        schemaVersion: 'chat-run-event/1',
        eventId: event.id,
        cursor: Number(event.cursor),
        conversationId: event.conversation_id,
        modelInvocationId: event.model_invocation_id,
        assistantMessageId: event.assistant_message_id,
        sequence: Number(event.sequence),
        occurredAt: event.occurred_at.toISOString(),
        eventType: event.event_type,
        ...event.payload,
      }));
    });
  }

  async claimChatTurn(workerInstanceId: string, tokenSecret: string, leaseDurationMs: number): Promise<ChatTurnClaim | null> {
    return this.withTransaction(async (client) => {
      await this.settleExpiredChatTurnsInTransaction(client);
      const selected = await client.query<{
        tenant_id: string; id: string; principal_id: string; conversation_id: string; model_invocation_id: string;
        user_message_id: string; assistant_message_id: string; execution_fence: string; deadline: Date;
      }>(`SELECT dispatch.tenant_id,dispatch.id,dispatch.principal_id,dispatch.conversation_id,
          dispatch.model_invocation_id,invocation.user_message_id,dispatch.assistant_message_id,
          dispatch.execution_fence::text,dispatch.deadline
        FROM chat_turn_dispatches dispatch
        JOIN model_invocations invocation ON invocation.tenant_id=dispatch.tenant_id
          AND invocation.id=dispatch.model_invocation_id
        WHERE dispatch.status='pending' AND dispatch.deadline>now()
        ORDER BY dispatch.created_at,dispatch.id FOR UPDATE OF dispatch SKIP LOCKED LIMIT 1`);
      const row = selected.rows[0];
      if (row === undefined) return null;
      const globallyActive = await client.query(`SELECT 1 FROM chat_turn_dispatches
        WHERE status IN ('leased','running','cancel_requested') LIMIT 1`);
      if (globallyActive.rowCount !== 0) return null;
      const attemptId = id('chat_attempt');
      const context = await this.buildContext(
        client, row.tenant_id, row.conversation_id, row.user_message_id, row.assistant_message_id,
      );
      const prompt = await client.query<{ policy: { system?: unknown } }>(`SELECT policy FROM prompt_policy_versions
        WHERE tenant_id=$1 AND id='prompt_xiaowei_chat_system_v1'`, [row.tenant_id]);
      const systemPrompt = prompt.rows[0]?.policy.system;
      if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) {
        throw new GenewayError('MODEL_ROUTE_UNAVAILABLE', 'Chat prompt policy is unavailable', 503);
      }
      const updated = await client.query(`UPDATE chat_turn_dispatches SET status='leased',attempt_id=$3,
        worker_instance_id=$4,lease_until=now()+($5::bigint * interval '1 millisecond'),updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [row.tenant_id, row.id, attemptId, workerInstanceId, leaseDurationMs]);
      if (updated.rowCount !== 1) throw new GenewayError('CHAT_CLAIM_CONFLICT', 'Chat turn claim changed concurrently', 409);
      await client.query(`UPDATE model_invocations SET context_message_ids=$3,context_truncated=$4
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [
        row.tenant_id, row.model_invocation_id, JSON.stringify(context.messages.map((message) => message.messageId)), context.truncated,
      ]);
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const deadlineSeconds = Math.floor(row.deadline.getTime() / 1_000);
      const claims: InvocationTokenClaims = {
        iss: 'geneway-control-plane',
        aud: 'local-model-gateway',
        tenantId: row.tenant_id,
        principalId: row.principal_id,
        conversationId: row.conversation_id,
        modelInvocationId: row.model_invocation_id,
        logicalModelPolicy: 'general.chat.standard',
        dataClass: 'C0',
        maxOutputTokens: 2_048,
        deadline: row.deadline.toISOString(),
        fence: Number(row.execution_fence),
        jti: randomUUID(),
        iat: nowSeconds,
        exp: Math.min(nowSeconds + 60, deadlineSeconds),
      };
      await client.query(`INSERT INTO model_invocation_token_authorizations
        (tenant_id,jti,model_invocation_id,dispatch_id,execution_fence,expires_at)
        VALUES ($1,$2,$3,$4,$5,to_timestamp($6))`, [
        row.tenant_id, claims.jti, row.model_invocation_id, row.id, claims.fence, claims.exp,
      ]);
      return {
        dispatchId: row.id,
        conversationId: row.conversation_id,
        modelInvocationId: row.model_invocation_id,
        assistantMessageId: row.assistant_message_id,
        attemptId,
        fence: Number(row.execution_fence),
        deadline: row.deadline.toISOString(),
        invocationToken: encodeToken(claims, tokenSecret),
        logicalModelPolicy: 'general.chat.standard',
        promptPolicyVersion: 'xiaowei.chat.system/1',
        systemPrompt,
        context: context.messages,
        contextTruncated: context.truncated,
      };
    });
  }

  async settleExpiredChatTurns(): Promise<number> {
    return this.withTransaction((client) => this.settleExpiredChatTurnsInTransaction(client));
  }

  async consumeInvocationToken(token: string, tokenSecret: string): Promise<boolean> {
    let claims: InvocationTokenClaims;
    try {
      claims = verifyToken(token, tokenSecret);
    } catch {
      return false;
    }
    return this.withTransaction(async (client) => {
      const consumed = await client.query(`UPDATE model_invocation_token_authorizations AS token_auth
        SET consumed_at=now()
        FROM chat_turn_dispatches dispatch,model_invocations invocation
        WHERE token_auth.tenant_id=$1 AND token_auth.jti=$2
          AND token_auth.model_invocation_id=$3 AND token_auth.execution_fence=$4
          AND token_auth.consumed_at IS NULL AND token_auth.expires_at>now()
          AND dispatch.tenant_id=token_auth.tenant_id AND dispatch.id=token_auth.dispatch_id
          AND dispatch.model_invocation_id=token_auth.model_invocation_id
          AND dispatch.execution_fence=token_auth.execution_fence AND dispatch.attempt_id IS NOT NULL
          AND dispatch.status IN ('leased','running') AND dispatch.lease_until>now()
          AND invocation.tenant_id=token_auth.tenant_id AND invocation.id=token_auth.model_invocation_id
          AND invocation.conversation_id=$5 AND invocation.requester_id=$6
          AND invocation.logical_model_policy=$7 AND invocation.status IN ('pending','running')`, [
        claims.tenantId, claims.jti, claims.modelInvocationId, claims.fence,
        claims.conversationId, claims.principalId, claims.logicalModelPolicy,
      ]);
      return consumed.rowCount === 1;
    });
  }

  async chatStarted(mutation: ChatWorkerMutation): Promise<void> {
    await this.withTransaction(async (client) => {
      const row = await this.lockMutation(client, mutation, ['leased']);
      const started = await client.query(`UPDATE chat_turn_dispatches SET status='running',lease_until=deadline,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND deadline>now()`, [row.tenant_id, mutation.dispatchId]);
      if (started.rowCount !== 1) throw new GenewayError('STALE_CHAT_ATTEMPT', 'Chat invocation deadline has expired', 409);
      await client.query(`UPDATE model_invocations SET status='running',started_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [row.tenant_id, mutation.modelInvocationId]);
      await this.appendEvent(client, row, 'run.started', { status: 'running' });
    });
  }

  async chatDelta(mutation: ChatWorkerMutation, delta: string): Promise<void> {
    if (delta.length === 0 || delta.includes('\0')) throw new GenewayError('MODEL_PROTOCOL_VIOLATION', 'Model delta is invalid', 409);
    await this.withTransaction(async (client) => {
      const row = await this.lockMutation(client, mutation, ['running']);
      const message = await client.query<{ body: string; content_version: string }>(`UPDATE messages
        SET body=body || $3,content_version=content_version+1
        WHERE tenant_id=$1 AND id=$2 AND status='streaming'
        RETURNING body,content_version::text`, [row.tenant_id, row.assistant_message_id, delta]);
      const checkpoint = message.rows[0];
      if (checkpoint === undefined) throw new GenewayError('CHAT_TERMINAL_CONFLICT', 'Assistant message no longer accepts deltas', 409);
      await this.appendEvent(client, row, 'message.delta', {
        delta,
        checkpoint: checkpoint.body,
        contentLength: Buffer.byteLength(checkpoint.body, 'utf8'),
        contentVersion: Number(checkpoint.content_version),
      });
    });
  }

  async chatCompleted(mutation: ChatWorkerMutation, receipt: ModelGatewayReceipt, receiptSecret: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const row = await this.lockMutation(client, mutation, ['running']);
      const attestation = this.verifyGatewayReceipt(receipt, receiptSecret, mutation, row, 'completed');
      if (attestation.payload.outcome !== 'completed') throw new GenewayError('MODEL_AUTH_FAILED', 'Gateway receipt outcome is invalid', 401);
      const message = await client.query<{ body: string; content_version: string }>(`UPDATE messages
        SET status='completed',completed_at=now(),content_version=content_version+1
        WHERE tenant_id=$1 AND id=$2 AND status='streaming' AND length(body)>0
        RETURNING body,content_version::text`, [row.tenant_id, row.assistant_message_id]);
      const checkpoint = message.rows[0];
      if (checkpoint === undefined) throw new GenewayError('MODEL_PROTOCOL_VIOLATION', 'Model completed without text output', 409);
      await client.query(`UPDATE chat_turn_dispatches SET status='completed',lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, mutation.dispatchId]);
      await client.query(`UPDATE model_invocations SET status='completed',provider_revision=$3,model_revision=$4,
        usage=$5,terminal_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'`, [
        row.tenant_id, mutation.modelInvocationId, attestation.payload.providerRevision,
        attestation.payload.modelRevision, attestation.payload.usage,
      ]);
      await client.query(`INSERT INTO model_gateway_audit
        (tenant_id,id,conversation_id,model_invocation_id,route_profile,provider_revision,model_revision,outcome,usage,
          gateway_receipt_jti,receipt_digest,attested)
        VALUES ($1,$2,$3,$4,'codex_subscription_dev',$5,$6,'completed',$7,$8,$9,true)`, [
        row.tenant_id, id('gateway_audit'), row.conversation_id, mutation.modelInvocationId,
        attestation.payload.providerRevision, attestation.payload.modelRevision, attestation.payload.usage,
        attestation.payload.receiptJti, attestation.digest,
      ]);
      await this.appendEvent(client, row, 'message.completed', {
        status: 'completed',
        checkpoint: checkpoint.body,
        contentLength: Buffer.byteLength(checkpoint.body, 'utf8'),
        contentVersion: Number(checkpoint.content_version),
      });
    });
  }

  async chatFailed(mutation: ChatWorkerMutation, receipt: ModelGatewayReceipt, receiptSecret: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const row = await this.lockMutation(client, mutation, ['leased', 'running']);
      const attestation = this.verifyGatewayReceipt(receipt, receiptSecret, mutation, row, 'failed');
      if (attestation.payload.outcome === 'completed') throw new GenewayError('MODEL_AUTH_FAILED', 'Gateway receipt outcome is invalid', 401);
      const errorClass: ChatErrorClass = attestation.payload.outcome;
      await client.query(`UPDATE messages SET status='failed',completed_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='streaming'`, [row.tenant_id, row.assistant_message_id]);
      await client.query(`UPDATE chat_turn_dispatches SET status='failed',lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, mutation.dispatchId]);
      await client.query(`UPDATE model_invocations SET status='failed',error_class=$3,terminal_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','running')`, [row.tenant_id, mutation.modelInvocationId, errorClass]);
      await client.query(`INSERT INTO model_gateway_audit
        (tenant_id,id,conversation_id,model_invocation_id,route_profile,provider_revision,model_revision,outcome,usage,
          gateway_receipt_jti,receipt_digest,attested)
        VALUES ($1,$2,$3,$4,'codex_subscription_dev',$5,$6,$7,NULL,$8,$9,true)`, [
        row.tenant_id, id('gateway_audit'), row.conversation_id, mutation.modelInvocationId,
        attestation.payload.providerRevision, attestation.payload.modelRevision, errorClass,
        attestation.payload.receiptJti, attestation.digest,
      ]);
      await this.appendEvent(client, row, 'run.failed', {
        status: 'failed', errorClass,
        ...(attestation.payload.retryNotBefore === undefined ? {} : { retryNotBefore: attestation.payload.retryNotBefore }),
      });
    });
  }

  async cancelChatRun(
    principal: Principal,
    conversationId: string,
    invocationId: string,
    idempotencyKey: string,
  ): Promise<CancelChatRunProjection> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new GenewayError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required', 400);
    }
    return this.withTransaction(async (client) => {
      const locked = await client.query<{
        tenant_id: string; dispatch_id: string; assistant_message_id: string; attempt_id: string | null;
        dispatch_status: 'pending' | 'leased' | 'running' | 'cancel_requested' | 'completed' | 'canceled' | 'failed';
        invocation_status: InvocationRow['status']; execution_fence: string; last_event_cursor: string;
      }>(`SELECT dispatch.tenant_id,dispatch.id dispatch_id,dispatch.assistant_message_id,dispatch.attempt_id,
          dispatch.status dispatch_status,invocation.status invocation_status,
          dispatch.execution_fence::text,invocation.last_event_cursor::text
        FROM chat_turn_dispatches dispatch
        JOIN model_invocations invocation ON invocation.tenant_id=dispatch.tenant_id
          AND invocation.id=dispatch.model_invocation_id
        WHERE dispatch.tenant_id=$1 AND dispatch.conversation_id=$2 AND dispatch.model_invocation_id=$3
          AND dispatch.principal_id=$4 AND invocation.requester_id=$4
        FOR UPDATE OF dispatch,invocation`, [principal.tenantId, conversationId, invocationId, principal.userId]);
      const row = locked.rows[0];
      if (row === undefined) throw new GenewayError('CHAT_RUN_NOT_FOUND', 'Chat run was not found', 404);
      if (row.invocation_status === 'canceled') {
        return cancelChatRunProjectionSchema.parse({
          modelInvocationId: invocationId, status: 'canceled', eventCursor: Number(row.last_event_cursor),
        });
      }
      if (row.invocation_status === 'cancel_requested') {
        return cancelChatRunProjectionSchema.parse({
          modelInvocationId: invocationId, status: 'cancel_requested', eventCursor: Number(row.last_event_cursor),
        });
      }
      if (['completed', 'failed'].includes(row.invocation_status)) {
        throw new GenewayError('CHAT_CANCEL_NOT_ALLOWED', `Chat run cannot be canceled from state ${row.invocation_status}`, 409);
      }
      const nextFence = Number(row.execution_fence) + 1;
      await client.query(`UPDATE model_invocation_token_authorizations SET expires_at=least(expires_at,now())
        WHERE tenant_id=$1 AND model_invocation_id=$2`, [row.tenant_id, invocationId]);
      if (row.dispatch_status === 'pending' && row.attempt_id === null) {
        await client.query(`UPDATE chat_turn_dispatches SET status='canceled',execution_fence=$3,lease_until=NULL,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status='pending' AND execution_fence=$4`, [
          row.tenant_id, row.dispatch_id, nextFence, Number(row.execution_fence),
        ]);
        await client.query(`UPDATE model_invocations SET status='canceled',execution_fence=$3,terminal_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [row.tenant_id, invocationId, nextFence]);
        await client.query(`UPDATE messages SET status='canceled',completed_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status='streaming'`, [row.tenant_id, row.assistant_message_id]);
        await this.appendEvent(client, {
          tenant_id: row.tenant_id, conversation_id: conversationId,
          model_invocation_id: invocationId, assistant_message_id: row.assistant_message_id,
        }, 'run.canceled', { status: 'canceled', reason: 'USER_CANCELED' });
        const cursor = await client.query<{ cursor: string }>(`SELECT last_event_cursor::text cursor FROM model_invocations
          WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, invocationId]);
        return cancelChatRunProjectionSchema.parse({
          modelInvocationId: invocationId, status: 'canceled', eventCursor: Number(cursor.rows[0]?.cursor),
        });
      }
      const dispatch = await client.query(`UPDATE chat_turn_dispatches SET status='cancel_requested',execution_fence=$3,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('leased','running') AND execution_fence=$4`, [
        row.tenant_id, row.dispatch_id, nextFence, Number(row.execution_fence),
      ]);
      if (dispatch.rowCount !== 1) throw new GenewayError('CHAT_CANCEL_CAS_CONFLICT', 'Cancellation lost the compare-and-set race', 409);
      await client.query(`UPDATE model_invocations SET status='cancel_requested',execution_fence=$3
        WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','running')`, [row.tenant_id, invocationId, nextFence]);
      return cancelChatRunProjectionSchema.parse({
        modelInvocationId: invocationId, status: 'cancel_requested', eventCursor: Number(row.last_event_cursor),
      });
    });
  }

  async requestedCancellationFence(mutation: ChatWorkerMutation): Promise<number | null> {
    const result = await this.pool.query<{ execution_fence: string }>(`SELECT execution_fence::text FROM chat_turn_dispatches
      WHERE id=$1 AND model_invocation_id=$2 AND attempt_id=$3 AND execution_fence=$4+1
        AND status='cancel_requested' AND lease_until>now()`, [
      mutation.dispatchId, mutation.modelInvocationId, mutation.attemptId, mutation.fence,
    ]);
    return result.rows[0] === undefined ? null : Number(result.rows[0].execution_fence);
  }

  async chatCanceled(mutation: ChatWorkerMutation): Promise<void> {
    await this.withTransaction(async (client) => {
      const row = await this.lockMutation(client, mutation, ['cancel_requested']);
      await client.query(`UPDATE messages SET status='canceled',completed_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='streaming'`, [row.tenant_id, row.assistant_message_id]);
      await client.query(`UPDATE chat_turn_dispatches SET status='canceled',lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='cancel_requested'`, [row.tenant_id, mutation.dispatchId]);
      await client.query(`UPDATE model_invocations SET status='canceled',terminal_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='cancel_requested' AND execution_fence=$3`, [
        row.tenant_id, mutation.modelInvocationId, mutation.fence,
      ]);
      await this.appendEvent(client, row, 'run.canceled', { status: 'canceled', reason: 'USER_CANCELED' });
    });
  }

  private async projectRun(client: pg.PoolClient, principal: Principal, conversationId: string, invocationId: string): Promise<ChatRunProjection> {
    const result = await client.query<InvocationRow>(`SELECT id,conversation_id,user_message_id,assistant_message_id,status,error_class,
      last_event_cursor::text,created_at,terminal_at FROM model_invocations
      WHERE tenant_id=$1 AND id=$2 AND conversation_id=$3 AND requester_id=$4`, [
      principal.tenantId, invocationId, conversationId, principal.userId,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('CHAT_RUN_NOT_FOUND', 'Chat run was not found', 404);
    return chatRunProjectionSchema.parse({
      conversationId: row.conversation_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      modelInvocationId: row.id,
      eventCursor: Number(row.last_event_cursor),
      status: row.status,
    });
  }

  private async buildContext(
    client: pg.PoolClient,
    tenantId: string,
    conversationId: string,
    currentUserMessageId: string,
    excludedAssistantMessageId: string,
  ): Promise<{
    messages: readonly Readonly<{ messageId: string; author: 'user' | 'xiaowei'; content: string }>[];
    truncated: boolean;
  }> {
    const result = await client.query<{
      id: string; author: 'user' | 'xiaowei'; body: string; status: 'completed' | 'streaming' | 'failed' | 'canceled';
    }>(`SELECT id,author,body,status FROM messages
      WHERE tenant_id=$1 AND conversation_id=$2 AND id<>$3
      ORDER BY sequence`, [tenantId, conversationId, excludedAssistantMessageId]);
    type ContextMessage = { messageId: string; author: 'user' | 'xiaowei'; content: string };
    const turns: ContextMessage[][] = [];
    let currentUser: ContextMessage | undefined;
    for (const message of result.rows) {
      if (message.author === 'user' && message.status === 'completed') {
        const normalized = { messageId: message.id, author: message.author, content: message.body.normalize('NFC') } as const;
        if (message.id === currentUserMessageId) currentUser = normalized;
        else turns.push([normalized]);
      } else if (message.author === 'xiaowei' && message.status === 'completed') {
        const latestTurn = turns.at(-1);
        if (latestTurn?.length === 1 && latestTurn[0]?.author === 'user') {
          latestTurn.push({ messageId: message.id, author: message.author, content: message.body.normalize('NFC') });
        }
      }
    }
    if (currentUser === undefined) throw new GenewayError('CHAT_CONTEXT_INVALID', 'Current chat user message is unavailable', 409);
    const completeTurns = turns.filter((turn) => turn.length === 2);
    completeTurns.push([currentUser]);
    const selectedTurns: ContextMessage[][] = [];
    let selectedCount = 0;
    let bytes = 0;
    let truncated = false;
    for (let index = completeTurns.length - 1; index >= 0; index -= 1) {
      const turn = completeTurns[index];
      if (turn === undefined) continue;
      const turnBytes = turn.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0);
      if (selectedCount + turn.length > MAX_CONTEXT_MESSAGES || bytes + turnBytes > MAX_CONTEXT_BYTES) {
        truncated = true;
        break;
      }
      selectedTurns.push(turn);
      selectedCount += turn.length;
      bytes += turnBytes;
    }
    return { messages: selectedTurns.reverse().flat(), truncated };
  }

  private async appendEvent(
    client: pg.PoolClient,
    row: Readonly<{ tenant_id: string; conversation_id: string; model_invocation_id: string; assistant_message_id: string }>,
    eventType: ChatRunEvent['eventType'],
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const sequence = await client.query<{ sequence: string }>(`SELECT coalesce(max(sequence),0)+1::bigint AS sequence
      FROM chat_run_events WHERE tenant_id=$1 AND model_invocation_id=$2`, [row.tenant_id, row.model_invocation_id]);
    const inserted = await client.query<{ cursor: string }>(`INSERT INTO chat_run_events
      (tenant_id,id,conversation_id,model_invocation_id,assistant_message_id,sequence,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING cursor::text`, [
      row.tenant_id, id('chat_event'), row.conversation_id, row.model_invocation_id, row.assistant_message_id,
      Number(sequence.rows[0]?.sequence), eventType, payload,
    ]);
    await client.query(`UPDATE model_invocations SET last_event_cursor=$3 WHERE tenant_id=$1 AND id=$2`, [
      row.tenant_id, row.model_invocation_id, Number(inserted.rows[0]?.cursor),
    ]);
  }

  private async settleExpiredChatTurnsInTransaction(client: pg.PoolClient): Promise<number> {
    const expired = await client.query<{
      tenant_id: string; id: string; conversation_id: string; model_invocation_id: string;
      assistant_message_id: string; status: 'pending' | 'leased' | 'running' | 'cancel_requested';
    }>(`SELECT tenant_id,id,conversation_id,model_invocation_id,assistant_message_id,status
      FROM chat_turn_dispatches
      WHERE status IN ('pending','leased','running','cancel_requested') AND deadline<=now()
      ORDER BY deadline,id FOR UPDATE`);
    for (const row of expired.rows) {
      const canceled = row.status === 'cancel_requested';
      const terminalStatus = canceled ? 'canceled' : 'failed';
      await client.query(`UPDATE messages SET status=$3,completed_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='streaming'`, [row.tenant_id, row.assistant_message_id, terminalStatus]);
      await client.query(`UPDATE chat_turn_dispatches SET status=$3,lease_until=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, row.id, terminalStatus]);
      await client.query(`UPDATE model_invocation_token_authorizations SET expires_at=least(expires_at,now())
        WHERE tenant_id=$1 AND model_invocation_id=$2`, [row.tenant_id, row.model_invocation_id]);
      await client.query(`UPDATE model_invocations SET status=$3,error_class=$4,terminal_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','running','cancel_requested')`, [
        row.tenant_id, row.model_invocation_id, terminalStatus, canceled ? null : 'MODEL_STREAM_INTERRUPTED',
      ]);
      await this.appendEvent(client, row, canceled ? 'run.canceled' : 'run.failed', canceled
        ? { status: 'canceled', reason: 'USER_CANCELED' }
        : { status: 'failed', errorClass: 'MODEL_STREAM_INTERRUPTED' });
    }
    return expired.rowCount ?? expired.rows.length;
  }

  private async lockMutation(client: pg.PoolClient, mutation: ChatWorkerMutation, allowedStatuses: readonly string[]): Promise<{
    tenant_id: string; conversation_id: string; model_invocation_id: string; assistant_message_id: string; deadline: Date;
  }> {
    const result = await client.query<{
      tenant_id: string; conversation_id: string; model_invocation_id: string; assistant_message_id: string; deadline: Date;
    }>(`SELECT tenant_id,conversation_id,model_invocation_id,assistant_message_id,deadline FROM chat_turn_dispatches
      WHERE id=$1 AND model_invocation_id=$2 AND attempt_id=$3 AND execution_fence=$4
        AND status=ANY($5::text[]) AND lease_until>now() FOR UPDATE`, [
      mutation.dispatchId, mutation.modelInvocationId, mutation.attemptId, mutation.fence, allowedStatuses,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('STALE_CHAT_ATTEMPT', 'Chat mutation has stale or expired authority', 409);
    return row;
  }

  private verifyGatewayReceipt(
    receiptValue: ModelGatewayReceipt,
    secret: string,
    mutation: ChatWorkerMutation,
    row: Readonly<{ conversation_id: string; model_invocation_id: string; deadline: Date }>,
    expected: 'completed' | 'failed',
  ): Readonly<{ payload: ModelGatewayReceiptPayload; digest: string }> {
    const receipt = modelGatewayReceiptSchema.parse(receiptValue);
    const expectedSignature = createHmac('sha256', secret).update(JSON.stringify(receipt.payload), 'utf8').digest('base64url');
    const supplied = Buffer.from(receipt.signature, 'utf8');
    const wanted = Buffer.from(expectedSignature, 'utf8');
    if (supplied.byteLength !== wanted.byteLength || !timingSafeEqual(supplied, wanted)) {
      throw new GenewayError('MODEL_AUTH_FAILED', 'Gateway receipt signature is invalid', 401);
    }
    const issuedAt = Date.parse(receipt.payload.issuedAt);
    if (receipt.payload.conversationId !== row.conversation_id
      || receipt.payload.modelInvocationId !== row.model_invocation_id
      || receipt.payload.modelInvocationId !== mutation.modelInvocationId
      || receipt.payload.fence !== mutation.fence
      || (expected === 'completed') !== (receipt.payload.outcome === 'completed')
      || issuedAt > Date.now() + 5_000 || issuedAt < Date.now() - 5 * 60_000 || issuedAt > row.deadline.getTime()) {
      throw new GenewayError('MODEL_AUTH_FAILED', 'Gateway receipt is stale or bound to another invocation', 401);
    }
    return {
      payload: receipt.payload,
      digest: createHash('sha256').update(JSON.stringify(receipt), 'utf8').digest('hex'),
    };
  }

  private async assertConversationOwned(client: pg.PoolClient, principal: Principal, conversationId: string): Promise<void> {
    const result = await client.query('SELECT 1 FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3 FOR UPDATE', [
      principal.tenantId, conversationId, principal.userId,
    ]);
    if (result.rowCount !== 1) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found', 404);
  }

  private async assertInvocationOwned(client: pg.PoolClient, principal: Principal, conversationId: string, invocationId: string): Promise<void> {
    const result = await client.query(`SELECT 1 FROM model_invocations WHERE tenant_id=$1 AND id=$2
      AND conversation_id=$3 AND requester_id=$4`, [principal.tenantId, invocationId, conversationId, principal.userId]);
    if (result.rowCount !== 1) throw new GenewayError('CHAT_RUN_NOT_FOUND', 'Chat run was not found', 404);
  }

  private async withTransaction<T>(effect: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await effect(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
