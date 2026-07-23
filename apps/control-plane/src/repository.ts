import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import {
  approvalProjectionSchema,
  conversationProjectionSchema,
  GenewayError,
  SIMULATION_ENVELOPE,
  isGenewayError,
  resolvedTaskInputRefSchema,
  taskListItemSchema,
  taskListResponseSchema,
  taskEventProjectionSchema,
  taskResultSchema,
  taskSnapshotSchema,
  workflowDetailProjectionSchema,
  workflowListItemSchema,
  workflowListResponseSchema,
  type CreateTaskInput,
  type ExecuteTaskInput,
  type ApprovalProjection,
  type ConversationProjection,
  type Principal,
  type ResolvedTaskInputRef,
  type TaskListQuery,
  type TaskListResponse,
  type TaskEventProjection,
  type TaskSnapshot,
  type WorkflowDetailProjection,
  type WorkflowListQuery,
  type WorkflowListResponse,
} from '@geneway/contracts';
import {
  FIXTURE_REF,
  FIXTURE_VERSION,
} from '@geneway/evidence';
import {
  SOLUTION_CAPABILITY_VERSION_ID,
  SOLUTION_HARNESS_VERSION_ID,
  EXCEPTION_ASSIST_CAPABILITY_VERSION_ID,
  compileWorkflow,
  createSolutionAnalysisDocumentDraft,
  createSolutionAnalysisDraft,
  hashCanonical,
  readStoredWorkflowVersion,
  type CompiledWorkflowVersion,
} from '@geneway/workflow';

const { Pool } = pg;
const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

function projectPrivateConversationAudience(value: string, conversationId: string) {
  const expected = `conversation:${conversationId}`;
  if (value !== expected) {
    throw new GenewayError('TASK_PROJECTION_INVALID', 'Evidence audience is not bound to the task conversation', 500);
  }
  return { kind: 'private_conversation' as const, conversationId };
}

type JsonObject = Readonly<Record<string, unknown>>;
export type ApprovalSubjectInput = Readonly<{
  taskId: string;
  requesterId: string;
  inputSnapshot: ResolvedTaskInputRef;
  expertTarget: JsonObject;
  expertCatalogVersionId: string;
  harnessVersionId: string;
  workflowVersionId: string;
  workflowHash: string;
  permissionScope: JsonObject;
  audienceScope: JsonObject;
  budget: JsonObject;
  inputDigest?: string | null;
}>;

export function buildApprovalSubject(input: ApprovalSubjectInput): JsonObject {
  const frozenExceptionInput = input.inputDigest === undefined || input.inputDigest === null ? {} : {
    requestedExpertTarget: input.expertTarget.requested,
    resolvedExpertTarget: input.expertTarget.resolved,
    inputDigest: input.inputDigest,
  };
  return {
    kind: 'workflow-execution',
    subjectType: 'business-task',
    subjectId: input.taskId,
    subjectVersion: 1,
    requesterId: input.requesterId,
    resolvedInputRef: input.inputSnapshot,
    ...(input.inputDigest === undefined || input.inputDigest === null
      ? { resolvedExpertTarget: input.expertTarget }
      : frozenExceptionInput),
    expertCatalogVersionId: input.expertCatalogVersionId,
    harnessVersionId: input.harnessVersionId,
    workflowVersionId: input.workflowVersionId,
    workflowHash: input.workflowHash,
    permissionScope: input.permissionScope,
    audienceScope: input.audienceScope,
    budget: input.budget,
    ...SIMULATION_ENVELOPE,
  };
}

type TaskRow = {
  tenant_id: string;
  id: string;
  conversation_id: string;
  status: string;
  capability_version_id: string;
  expert_catalog_version_id: string;
  harness_version_id: string;
  workflow_version_id: string;
  workflow_hash: string;
  requester_id: string;
  input_snapshot: JsonObject;
  input_digest: string | null;
  expert_target: JsonObject;
  permission_scope: JsonObject;
  audience_scope: JsonObject;
  budget: JsonObject;
  simulation: boolean;
  runtime_mode: string;
  business_decision_allowed: boolean;
  aggregate_version: string;
  result: unknown;
  execution_version: string;
  current_execution_attempt_id: string | null;
  execution_fencing_token: string;
  created_at: Date;
  updated_at: Date;
};

type ApprovalRow = {
  id: string;
  business_task_id: string;
  version: number;
  subject: JsonObject;
  subject_digest: string;
  status: string;
  requester_id: string;
  expires_at: Date;
};

type QuerySnapshotRow = {
  id: string;
  query_kind: 'business_tasks' | 'workflow_versions';
  authorization_epoch: string;
  canonical_query: JsonObject;
  query_version: string;
  field_mask_version: string;
  as_of: Date;
  expires_at: Date;
};

type WorkflowVersionRow = {
  id: string;
  workflow_hash: string;
  canonicalization_version: 'RFC8785/JCS-1';
  canonical_json: unknown;
  created_at: Date;
};

type PaginationCursorPayload = Readonly<{
  snapshotId: string;
  position: number;
  expiresAt: number;
}>;

const TASK_LIST_QUERY_VERSION = 'business-tasks.list.v1';
const TASK_LIST_FIELD_MASK_VERSION = 'business-tasks.list.public.v1';
const WORKFLOW_LIST_QUERY_VERSION = 'workflow-versions.list.v1';
const WORKFLOW_LIST_FIELD_MASK_VERSION = 'workflow-versions.list.public.v1';
const QUERY_SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
const TASK_PROJECTION_AUTHORIZATION_SQL = `
  t.requester_id=$2
  AND EXISTS (
    SELECT 1 FROM roles role_binding
    WHERE role_binding.tenant_id=t.tenant_id AND role_binding.user_id=$2 AND role_binding.role='solution_reviewer'
  )
  AND EXISTS (
    SELECT 1 FROM conversations owned_conversation
    WHERE owned_conversation.tenant_id=t.tenant_id AND owned_conversation.id=t.conversation_id
      AND owned_conversation.user_id=$2
  )
  AND (
    (
      coalesce(t.input_snapshot->>'kind','fixture')='fixture'
      AND EXISTS (
        SELECT 1 FROM resource_scopes readable_scope
        WHERE readable_scope.tenant_id=t.tenant_id AND readable_scope.user_id=$2
          AND readable_scope.resource_scope=t.input_snapshot->>'fixtureRef'
      )
    )
    OR (
      t.input_snapshot->>'kind'='document_snapshot'
      AND EXISTS (
        SELECT 1 FROM document_snapshots readable_snapshot
        JOIN artifacts readable_artifact
          ON readable_artifact.tenant_id=readable_snapshot.tenant_id
          AND readable_artifact.id=readable_snapshot.artifact_id
        WHERE readable_snapshot.tenant_id=t.tenant_id
          AND readable_snapshot.id=t.input_snapshot->>'documentSnapshotId'
          AND readable_snapshot.artifact_id=t.input_snapshot->>'artifactId'
          AND readable_snapshot.manifest_id=t.input_snapshot->>'manifestId'
          AND readable_snapshot.content_sha256=t.input_snapshot->>'contentSha256'
          AND readable_snapshot.simulation_profile=t.input_snapshot->>'simulationProfile'
          AND readable_snapshot.profile_registry_version=t.input_snapshot->>'profileRegistryVersion'
          AND readable_snapshot.resource_scope=t.input_snapshot->>'resourceScope'
          AND readable_snapshot.data_class=t.input_snapshot->>'dataClass'
          AND ('conversation:' || readable_snapshot.conversation_id)=t.input_snapshot->>'audience'
          AND readable_snapshot.conversation_id=t.conversation_id
          AND readable_snapshot.created_by=$2
          AND readable_artifact.owner_user_id=$2
      )
    )
    OR (
      t.input_snapshot->>'kind'='business_exception_snapshot'
      AND t.input_snapshot->'taskAudience'=jsonb_build_object(
        'kind','private_conversation','conversationId',t.conversation_id)
      AND EXISTS (
        SELECT 1
        FROM business_exception_source_snapshots readable_exception_source
        JOIN business_exception_analysis_bindings readable_exception_binding
          ON readable_exception_binding.tenant_id=readable_exception_source.tenant_id
          AND readable_exception_binding.source_version_id=readable_exception_source.source_version_id
        JOIN resource_scopes readable_scope
          ON readable_scope.tenant_id=readable_exception_source.tenant_id
          AND readable_scope.user_id=$2
        WHERE readable_exception_source.tenant_id=t.tenant_id
          AND readable_exception_source.business_exception_id=t.input_snapshot->>'businessExceptionId'
          AND readable_exception_source.source_version_id=t.input_snapshot->>'sourceVersionId'
          AND readable_exception_source.canonical_sha256=t.input_snapshot->>'sourceSha256'
          AND readable_exception_source.canonicalization_version=t.input_snapshot->>'canonicalizationVersion'
          AND readable_exception_source.resource_scope=t.input_snapshot->>'resourceScope'
          AND readable_exception_source.data_class=t.input_snapshot->>'dataClass'
          AND readable_exception_source.audience=t.input_snapshot->'sourceAudience'
          AND readable_exception_binding.business_task_id=t.id
          AND readable_exception_binding.requester_principal_id=$2
          AND readable_exception_binding.private_conversation_id=t.conversation_id
          AND readable_exception_binding.task_audience=t.input_snapshot->'taskAudience'
          AND (readable_exception_source.resource_scope=readable_scope.resource_scope
            OR readable_exception_source.resource_scope LIKE readable_scope.resource_scope || '/%')
      )
    )
  )`;

export type CreatedTask = Readonly<{
  taskId: string;
  approvalId: string;
  workflowVersionId: string;
  workflowHash: string;
}>;

export type ExecutionResponse = Readonly<{ taskId: string; status: 'accepted' | 'completed' }>;
export type CancellationResponse = Readonly<{ taskId: string; status: 'canceled' }>;

function normalizeStoredInput(value: JsonObject): ResolvedTaskInputRef {
  if (value.kind === 'fixture' || value.kind === 'document_snapshot' || value.kind === 'business_exception_snapshot') {
    return resolvedTaskInputRefSchema.parse(value);
  }
  if (value.fixtureRef === FIXTURE_REF) {
    return { kind: 'fixture', fixtureRef: FIXTURE_REF, fixtureVersion: FIXTURE_VERSION };
  }
  throw new GenewayError('TASK_INPUT_INVALID', 'Stored task input does not match a supported immutable input reference', 500);
}

export class ControlPlaneRepository {
  readonly pool: pg.Pool;
  private readonly cursorHmacSecret: string;

  constructor(connectionString: string, cursorHmacSecret: string) {
    if (cursorHmacSecret.length < 32) throw new Error('GENEWAY_CURSOR_HMAC_SECRET must contain at least 32 characters');
    this.pool = new Pool({ connectionString, max: 10 });
    this.cursorHmacSecret = cursorHmacSecret;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSystemSeed(): Promise<void> {
    await this.pool.query("INSERT INTO tenants (id,name) VALUES ('tenant_local','本机演示租户') ON CONFLICT DO NOTHING");
    await this.pool.query("INSERT INTO users (tenant_id,id,display_name) VALUES ('tenant_local','user_local','本机用户') ON CONFLICT DO NOTHING");
    await this.pool.query("INSERT INTO roles (tenant_id,user_id,role) VALUES ('tenant_local','user_local','solution_reviewer') ON CONFLICT DO NOTHING");
    await this.pool.query("INSERT INTO resource_scopes (tenant_id,user_id,resource_scope) VALUES ('tenant_local','user_local','fixture:solution-analysis:v1') ON CONFLICT DO NOTHING");
  }

  async resetForTest(): Promise<void> {
    await this.pool.query(`TRUNCATE TABLE
      platform_write_barriers,backup_sets,storage_orphan_tombstones,
      query_snapshot_items,query_snapshots,
      model_gateway_audit,chat_run_events,chat_turn_outbox,model_invocation_token_authorizations,chat_turn_dispatches,chat_idempotency_records,model_invocations,
      capability_active_releases,capability_release_records,prompt_policy_versions,
      report_publish_intents,lineage_records,evidence_links,evidence_items,claims,worker_command_receipts,attempt_output_candidates,
      inbox_events,outbox_deliveries,execution_attempts,
      audit_events,document_snapshots,artifact_states,artifact_manifests,artifacts,artifact_ingest_intents,
      idempotency_records,outbox_events,result_claims,minimal_evidence_refs,policy_decisions,
      delegated_capabilities,approval_versions,business_task_steps,business_task_events,
      business_tasks,workflow_versions,harness_versions,expert_catalog_versions,
      capability_versions,messages,conversations,resource_scopes,roles,users,tenants
      RESTART IDENTITY CASCADE`);
    await this.ensureSystemSeed();
    await this.ensureChatSeed();
  }

  private async ensureChatSeed(): Promise<void> {
    await this.pool.query(`INSERT INTO capability_versions(tenant_id,id,capability_id,version,spec)
      VALUES ('tenant_local','capability_xiaowei_chat_v1','xiaowei.chat.v1',1,
        '{"logicalModelPolicy":"general.chat.standard","dataClasses":["C0","C1"],"toolChoice":"none","context":{"maxMessages":24,"maxBytes":65536}}')
      ON CONFLICT DO NOTHING`);
    await this.pool.query(`INSERT INTO prompt_policy_versions(tenant_id,id,policy_id,version,policy)
      VALUES ('tenant_local','prompt_xiaowei_chat_system_v1','xiaowei.chat.system',1,
        '{"system":"你是小纬，geneway 的制造业数字员工。清晰、诚实地回答普通文本问题；不得声称使用工具、企业知识、联网搜索或执行生产写操作。"}')
      ON CONFLICT DO NOTHING`);
    await this.pool.query(`INSERT INTO capability_release_records
      (tenant_id,id,capability_version_id,prompt_policy_version_id,state,sequence,previous_release_id,actor,gate_evidence,gate_evidence_digest)
      VALUES ('tenant_local','release_xiaowei_chat_v1_draft','capability_xiaowei_chat_v1','prompt_xiaowei_chat_system_v1','draft',1,NULL,
        'user@source-thread:019f880e-bac8-7412-a129-68db9bf6506a',
        '{"kind":"authority-document","document":"gate-a0-fast-chat/brief.md","authorizationRef":"source-thread:019f880e-bac8-7412-a129-68db9bf6506a","sha256":"a6225da9a53c99583ce8459e6fb2e1d5af6366db859e415307e1c6b4994556ca"}',
        'a6225da9a53c99583ce8459e6fb2e1d5af6366db859e415307e1c6b4994556ca')
      ON CONFLICT DO NOTHING`);
    await this.pool.query(`INSERT INTO capability_active_releases(tenant_id,capability_id,release_id,pointer_version)
      VALUES ('tenant_local','xiaowei.chat.v1','release_xiaowei_chat_v1_draft',1) ON CONFLICT DO NOTHING`);
  }

  async createConversation(principal: Principal, idempotencyKey: string): Promise<{ id: string }> {
    return this.withTransaction((client) => this.idempotent(client, principal, 'conversation.create', idempotencyKey, {}, async () => {
      const conversationId = id('conversation');
      await client.query('INSERT INTO conversations (tenant_id,id,user_id) VALUES ($1,$2,$3)', [principal.tenantId, conversationId, principal.userId]);
      return { id: conversationId };
    }));
  }

  async addUserMessage(principal: Principal, conversationId: string, body: string, idempotencyKey: string): Promise<{ id: string }> {
    return this.withTransaction((client) => this.idempotent(client, principal, 'conversation.message.create', idempotencyKey, { conversationId, body }, async () => {
      await this.assertConversationOwned(client, principal, conversationId);
      const messageId = id('message');
      await client.query("INSERT INTO messages (tenant_id,id,conversation_id,author,body) VALUES ($1,$2,$3,'user',$4)", [principal.tenantId, messageId, conversationId, body]);
      return { id: messageId };
    }));
  }

  async getConversation(principal: Principal, conversationId: string): Promise<ConversationProjection> {
    return this.withTransaction(async (client) => {
      const conversation = await client.query<{ id: string; created_at: Date }>('SELECT id,created_at FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [principal.tenantId, conversationId, principal.userId]);
      const row = conversation.rows[0];
      if (row === undefined) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found', 404);
      const messages = await client.query<{ id: string; author: 'user' | 'xiaowei'; body: string; created_at: Date }>('SELECT id,author,body,created_at FROM messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY sequence', [principal.tenantId, conversationId]);
      const taskCandidates = await client.query<{ id: string }>(`SELECT id FROM business_tasks
        WHERE tenant_id=$1 AND conversation_id=$2 AND requester_id=$3 ORDER BY updated_at DESC,id ASC`, [
        principal.tenantId, conversationId, principal.userId,
      ]);
      let latestTaskId: string | null = null;
      for (const candidate of taskCandidates.rows) {
        try {
          latestTaskId = (await this.requireTaskProjectionReadable(client, principal, candidate.id)).id;
          break;
        } catch (error) {
          if (!this.isListVisibilityError(error)) throw error;
        }
      }
      return conversationProjectionSchema.parse({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        latestTaskId,
        messages: messages.rows.map((message) => ({
          id: message.id,
          author: message.author,
          body: message.body,
          createdAt: message.created_at.toISOString(),
        })),
      });
    });
  }

  async listTasks(principal: Principal, query: TaskListQuery): Promise<TaskListResponse> {
    return this.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      if (query.cursor === undefined) {
        const listCapability = await client.query(`SELECT 1 FROM users principal_user
          WHERE principal_user.tenant_id=$1 AND principal_user.id=$2
            AND EXISTS (SELECT 1 FROM roles role_binding
              WHERE role_binding.tenant_id=principal_user.tenant_id AND role_binding.user_id=principal_user.id
                AND role_binding.role='solution_reviewer')`, [principal.tenantId, principal.userId]);
        if (listCapability.rowCount !== 1) {
          throw new GenewayError('TASK_LIST_FORBIDDEN', 'Task list permission is required', 403);
        }
      }
      const canonicalQuery = {
        status: query.status ?? null,
        capabilityId: query.capabilityId ?? null,
        sort: query.sort,
        direction: query.direction,
        limit: query.limit,
      };
      const authorizationEpoch = await this.authorizationEpoch(client, principal);
      let snapshot: QuerySnapshotRow;
      let position = 0;

      if (query.cursor === undefined) {
        const orderColumn = query.sort === 'createdAt' ? 't.created_at' : 't.updated_at';
        const candidates = await client.query<TaskRow>(`SELECT t.* FROM business_tasks t
          JOIN capability_versions capability ON capability.tenant_id=t.tenant_id AND capability.id=t.capability_version_id
          WHERE t.tenant_id=$1 AND ${TASK_PROJECTION_AUTHORIZATION_SQL}
            AND ($3::text IS NULL OR t.status=$3)
            AND ($4::text IS NULL OR capability.capability_id=$4)
          ORDER BY ${orderColumn} DESC,t.id ASC`, [
          principal.tenantId, principal.userId, query.status ?? null, query.capabilityId ?? null,
        ]);
        const readable: TaskRow[] = [];
        for (const candidate of candidates.rows) {
          try {
            this.assertTaskProjectionContext(candidate);
            readable.push(candidate);
          } catch (error) {
            if (!this.isListVisibilityError(error)) throw error;
          }
        }
        snapshot = await this.createQuerySnapshot(client, principal, {
          kind: 'business_tasks',
          authorizationEpoch,
          canonicalQuery,
          queryVersion: TASK_LIST_QUERY_VERSION,
          fieldMaskVersion: TASK_LIST_FIELD_MASK_VERSION,
          items: readable.map((task) => ({
            objectId: task.id,
            sortKey: {
              value: (query.sort === 'createdAt' ? task.created_at : task.updated_at).toISOString(),
              id: task.id,
            },
          })),
        });
      } else {
        const cursor = this.parsePaginationCursor(query.cursor);
        position = cursor.position;
        snapshot = await this.requireQuerySnapshot(client, principal, cursor, {
          kind: 'business_tasks',
          authorizationEpoch,
          canonicalQuery,
          queryVersion: TASK_LIST_QUERY_VERSION,
          fieldMaskVersion: TASK_LIST_FIELD_MASK_VERSION,
        });
      }

      const page = await this.readQuerySnapshotPage(client, principal, snapshot, position, query.limit, async (objectId) => {
        try {
          return await this.projectTaskListItem(client, await this.requireTaskProjectionReadable(client, principal, objectId));
        } catch (error) {
          if (this.isListVisibilityError(error)) return null;
          throw error;
        }
      });
      return taskListResponseSchema.parse({
        tasks: page.items,
        nextCursor: page.nextCursor,
        asOf: snapshot.as_of.toISOString(),
        queryVersion: snapshot.query_version,
      });
    });
  }

  async createTask(principal: Principal, input: CreateTaskInput, idempotencyKey: string): Promise<CreatedTask> {
    return this.withTransaction((client) => this.idempotent(client, principal, 'business-task.create', idempotencyKey, input, async () => {
      await this.assertConversationOwned(client, principal, input.conversationId);
      const resolvedInput = await this.resolveInput(client, principal, input);
      const workflow = resolvedInput.kind === 'fixture'
        ? compileWorkflow(createSolutionAnalysisDraft())
        : compileWorkflow(createSolutionAnalysisDocumentDraft(resolvedInput.resourceScope));
      const versions = await this.ensureVersions(client, principal.tenantId, workflow);
      const resolvedExpert = this.resolveExpertTarget(input.expertTarget);
      const taskId = id('task');
      const approvalId = id('approval');
      const resourceScope = resolvedInput.kind === 'fixture' ? resolvedInput.fixtureRef : resolvedInput.resourceScope;
      const permissionScope = { actions: ['R0', 'R1', 'A1'], resourceScopes: [resourceScope], dataClasses: ['C0', 'C1'] };
      const audienceScope = { kind: 'private-conversation', ids: [`conversation:${input.conversationId}`] };
      const budget = { maxRuntimeMs: 30_000, maxModelCost: 0, modelCallsAllowed: false };
      const expertTarget = { requested: input.expertTarget, resolved: resolvedExpert };

      await client.query(`INSERT INTO business_tasks
        (tenant_id,id,conversation_id,capability_version_id,expert_catalog_version_id,harness_version_id,
         workflow_version_id,workflow_hash,requester_id,status,input_snapshot,expert_target,
         permission_scope,audience_scope,budget,simulation,runtime_mode,business_decision_allowed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12,$13,$14,true,'fake',false)`, [
        principal.tenantId, taskId, input.conversationId, SOLUTION_CAPABILITY_VERSION_ID,
        versions.expertCatalogVersionId, SOLUTION_HARNESS_VERSION_ID, workflow.id, workflow.hash,
        principal.userId, resolvedInput, expertTarget, permissionScope, audienceScope, budget,
      ]);

      for (const node of workflow.payload.nodes) {
        await client.query(`INSERT INTO business_task_steps
          (tenant_id,business_task_id,step_id,status,simulation,runtime_mode,business_decision_allowed)
          VALUES ($1,$2,$3,'queued',true,'fake',false)`, [principal.tenantId, taskId, node.id]);
      }

      const subject = buildApprovalSubject({
        taskId,
        requesterId: principal.userId,
        inputSnapshot: resolvedInput,
        expertTarget,
        expertCatalogVersionId: versions.expertCatalogVersionId,
        harnessVersionId: SOLUTION_HARNESS_VERSION_ID,
        workflowVersionId: workflow.id,
        workflowHash: workflow.hash,
        permissionScope,
        audienceScope,
        budget,
      });
      const subjectDigest = hashCanonical(subject);
      await client.query(`INSERT INTO approval_versions
        (tenant_id,id,business_task_id,version,subject,subject_digest,status,requester_id,approver_policy_version,expires_at)
        VALUES ($1,$2,$3,1,$4,$5,'pending',$6,'trusted-local-readonly/1',now()+interval '15 minutes')`,
      [principal.tenantId, approvalId, taskId, subject, subjectDigest, principal.userId]);
      await client.query(`INSERT INTO delegated_capabilities
        (tenant_id,id,business_task_id,principal_id,allowed_actions,resource_scopes,audience_scope,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes')`, [
        principal.tenantId, id('capability'), taskId, principal.userId,
        JSON.stringify(['R0', 'R1', 'A1']), JSON.stringify([resourceScope]), JSON.stringify([`conversation:${input.conversationId}`]),
      ]);
      await client.query('INSERT INTO policy_decisions (tenant_id,id,business_task_id,allow,reason_codes) VALUES ($1,$2,$3,true,$4)', [
        principal.tenantId, id('policy'), taskId,
        JSON.stringify(['TRUSTED_LOCAL', resolvedInput.kind === 'fixture' ? 'FIXTURE_SCOPE_ALLOWED' : 'DOCUMENT_SNAPSHOT_SCOPE_ALLOWED', 'ACTION_CEILING_A1']),
      ]);
      await this.appendEvent(client, principal.tenantId, taskId, 'business_task.created', {
        approvalId,
        workflowVersionId: workflow.id,
        workflowHash: workflow.hash,
      });
      return { taskId, approvalId, workflowVersionId: workflow.id, workflowHash: workflow.hash };
    }, async (response) => {
      await this.requireReadableTask(client, principal, response.taskId);
    }));
  }

  async getTask(principal: Principal, taskId: string): Promise<TaskSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const task = await this.requireTaskProjectionReadable(client, principal, taskId);
      const inputRef = normalizeStoredInput(task.input_snapshot);
      const approvalResult = await client.query<ApprovalRow>('SELECT * FROM approval_versions WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY version DESC LIMIT 1', [principal.tenantId, taskId]);
      const approval = approvalResult.rows[0];
      if (approval === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Task has no approval version', 500);
      const steps = await client.query<{ step_id: string; status: string }>('SELECT step_id,status FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY step_id', [principal.tenantId, taskId]);
      const claims = await client.query<{ id: string; text: string; status: 'published' | 'rejected'; rejection_code: string | null; evidence_id: string | null }>(`SELECT c.id,c.text,c.status,c.rejection_code,l.evidence_id
        FROM claims c
        LEFT JOIN evidence_links l ON l.tenant_id=c.tenant_id AND l.claim_id=c.id AND l.relation='supports'
        LEFT JOIN evidence_items linked_evidence ON linked_evidence.tenant_id=l.tenant_id AND linked_evidence.id=l.evidence_id
        WHERE c.tenant_id=$1 AND c.business_task_id=$2
          AND (c.status='rejected' OR (
            linked_evidence.accessible
            AND (linked_evidence.source_kind='legacy_fixture' OR EXISTS (
              SELECT 1 FROM document_snapshots current_snapshot
              JOIN artifact_states current_state ON current_state.tenant_id=current_snapshot.tenant_id AND current_state.artifact_id=current_snapshot.artifact_id
              WHERE current_snapshot.tenant_id=linked_evidence.tenant_id
                AND current_snapshot.id=linked_evidence.source->>'documentSnapshotId'
                AND current_snapshot.artifact_id=linked_evidence.source->>'artifactId'
                AND current_snapshot.content_sha256=linked_evidence.source->>'snapshotSha256'
                AND current_snapshot.resource_scope=linked_evidence.resource_scope
                AND current_snapshot.data_class=linked_evidence.data_class
                AND linked_evidence.audience='conversation:' || current_snapshot.conversation_id
                AND current_state.availability='active' AND current_state.integrity='verified'
                AND current_state.retention_status='active' AND current_state.retention_expires_at>now()
                AND current_state.reconcile_status='in_sync'
            ) OR (linked_evidence.source_kind='business_exception_snapshot' AND EXISTS (
              SELECT 1 FROM business_exception_source_snapshots current_exception_source
              JOIN business_exception_analysis_bindings current_exception_binding
                ON current_exception_binding.tenant_id=current_exception_source.tenant_id
                AND current_exception_binding.source_version_id=current_exception_source.source_version_id
              WHERE current_exception_source.tenant_id=linked_evidence.tenant_id
                AND current_exception_source.business_exception_id=linked_evidence.source->>'businessExceptionId'
                AND current_exception_source.source_version_id=linked_evidence.source->>'sourceVersionId'
                AND current_exception_source.canonical_sha256=linked_evidence.source->>'sourceSha256'
                AND current_exception_source.resource_scope=linked_evidence.resource_scope
                AND current_exception_source.data_class=linked_evidence.data_class
                AND current_exception_binding.business_task_id=linked_evidence.business_task_id
                AND linked_evidence.audience='conversation:' || current_exception_binding.private_conversation_id
            )))
          ))
        ORDER BY c.created_at,c.id`, [principal.tenantId, taskId]);
      const evidence = await client.query<{ id: string; source: unknown; excerpt_sha256: string; resource_scope: string; data_class: 'C1'; audience: string; lineage_ids: string[] }>(`SELECT e.id,e.source,e.excerpt_sha256,e.resource_scope,e.data_class,e.audience,
        coalesce(array_agg(l.id ORDER BY l.created_at,l.id) FILTER (WHERE l.id IS NOT NULL),'{}') lineage_ids
        FROM evidence_items e LEFT JOIN lineage_records l ON l.tenant_id=e.tenant_id AND l.business_task_id=e.business_task_id
          AND (l.from_id=e.id OR l.to_id=e.id)
        WHERE e.tenant_id=$1 AND e.business_task_id=$2 AND e.accessible
          AND (e.source_kind='legacy_fixture' OR EXISTS (
            SELECT 1 FROM document_snapshots current_snapshot
            JOIN artifact_states current_state ON current_state.tenant_id=current_snapshot.tenant_id AND current_state.artifact_id=current_snapshot.artifact_id
            WHERE current_snapshot.tenant_id=e.tenant_id
              AND current_snapshot.id=e.source->>'documentSnapshotId'
              AND current_snapshot.artifact_id=e.source->>'artifactId'
              AND current_snapshot.content_sha256=e.source->>'snapshotSha256'
              AND current_snapshot.resource_scope=e.resource_scope
              AND current_snapshot.data_class=e.data_class
              AND e.audience='conversation:' || current_snapshot.conversation_id
              AND current_state.availability='active' AND current_state.integrity='verified'
              AND current_state.retention_status='active' AND current_state.retention_expires_at>now()
              AND current_state.reconcile_status='in_sync'
          ) OR (e.source_kind='business_exception_snapshot' AND EXISTS (
            SELECT 1 FROM business_exception_source_snapshots current_exception_source
            JOIN business_exception_analysis_bindings current_exception_binding
              ON current_exception_binding.tenant_id=current_exception_source.tenant_id
              AND current_exception_binding.source_version_id=current_exception_source.source_version_id
            WHERE current_exception_source.tenant_id=e.tenant_id
              AND current_exception_source.business_exception_id=e.source->>'businessExceptionId'
              AND current_exception_source.source_version_id=e.source->>'sourceVersionId'
              AND current_exception_source.canonical_sha256=e.source->>'sourceSha256'
              AND current_exception_source.resource_scope=e.resource_scope
              AND current_exception_source.data_class=e.data_class
              AND current_exception_binding.business_task_id=e.business_task_id
              AND e.audience='conversation:' || current_exception_binding.private_conversation_id
          )))
        GROUP BY e.id,e.source,e.excerpt_sha256,e.resource_scope,e.data_class,e.audience
        ORDER BY min(e.created_at),e.id`, [principal.tenantId, taskId]);
      const sourceArtifactId = inputRef.kind === 'document_snapshot' ? inputRef.artifactId : null;
      const artifacts = await client.query<{ id: string; manifest_id: string; kind: 'source_document' | 'simulation_report'; display_name: string; media_type: 'text/plain' | 'text/markdown'; size_bytes: string; content_sha256: string; lineage_ids: string[] }>(`SELECT a.id,m.id manifest_id,a.kind,a.display_name,a.media_type,a.size_bytes::text,a.content_sha256,
        coalesce(array_agg(l.id ORDER BY l.created_at,l.id) FILTER (WHERE l.id IS NOT NULL),'{}') lineage_ids
        FROM artifacts a JOIN artifact_manifests m ON m.tenant_id=a.tenant_id AND m.artifact_id=a.id
        JOIN artifact_states artifact_state ON artifact_state.tenant_id=a.tenant_id AND artifact_state.artifact_id=a.id
        LEFT JOIN lineage_records l ON l.tenant_id=a.tenant_id AND l.business_task_id=$2 AND (l.from_id=a.id OR l.to_id=a.id)
        WHERE a.tenant_id=$1 AND (a.business_task_id=$2 OR a.id=$3)
          AND artifact_state.availability='active' AND artifact_state.integrity='verified'
          AND artifact_state.retention_status='active' AND artifact_state.retention_expires_at>now()
          AND artifact_state.reconcile_status='in_sync'
        GROUP BY a.id,m.id,a.kind,a.display_name,a.media_type,a.size_bytes,a.content_sha256
        ORDER BY min(a.created_at),a.id`, [principal.tenantId, taskId, sourceArtifactId]);
      const lineage = await client.query<{ id: string; from_kind: string; from_id: string; to_kind: string; to_id: string; relation: string }>('SELECT id,from_kind,from_id,to_kind,to_id,relation FROM lineage_records WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY created_at,id', [principal.tenantId, taskId]);
      const watermark = await client.query<{ watermark: string }>('SELECT coalesce(max(sequence),0)::text watermark FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2', [principal.tenantId, taskId]);
      const snapshot = taskSnapshotSchema.parse({
        id: task.id,
        capabilityId: this.capabilityIdForTask(task),
        title: this.capabilityIdForTask(task) === 'operations.exception-assist.v1' ? '异常分析' : '方案分析',
        conversationId: task.conversation_id,
        status: task.status,
        approvalStatus: approval.status,
        createdAt: task.created_at.toISOString(),
        updatedAt: task.updated_at.toISOString(),
        inputRef,
        workflowVersion: { id: task.workflow_version_id, hash: task.workflow_hash },
        approval: { id: approval.id, version: approval.version, status: approval.status, subjectDigest: approval.subject_digest },
        expertTarget: task.expert_target.requested ?? task.expert_target,
        steps: steps.rows.map((row) => ({ id: row.step_id, status: row.status })),
        claims: claims.rows.map((row) => ({ id: row.id, text: row.text, status: row.status, evidenceRefId: row.evidence_id, rejectionCode: row.rejection_code })),
        evidence: evidence.rows.map((row) => ({
          id: row.id,
          source: row.source,
          excerpt: null,
          excerptSha256: row.excerpt_sha256,
          resourceScope: row.resource_scope,
          dataClass: row.data_class,
          audience: projectPrivateConversationAudience(row.audience, task.conversation_id),
          lineageRecordIds: row.lineage_ids,
        })),
        artifacts: artifacts.rows.map((row) => ({
          id: row.id,
          manifestId: row.manifest_id,
          kind: row.kind,
          displayName: row.display_name,
          mediaType: row.media_type,
          sizeBytes: Number(row.size_bytes),
          contentSha256: row.content_sha256,
          downloadUrl: `/api/artifacts/${row.id}/download`,
          lineageRecordIds: row.lineage_ids,
        })),
        lineage: lineage.rows.map((row) => ({ id: row.id, fromKind: row.from_kind, fromId: row.from_id, toKind: row.to_kind, toId: row.to_id, relation: row.relation })),
        result: task.result,
        aggregateVersion: Number(task.aggregate_version),
        eventWatermark: Number(watermark.rows[0]?.watermark ?? 0),
        simulation: task.simulation,
        runtimeMode: task.runtime_mode,
        businessDecisionAllowed: task.business_decision_allowed,
      });
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getEvents(principal: Principal, taskId: string, afterCursor: number): Promise<readonly TaskEventProjection[]> {
    return this.withTransaction(async (client) => {
      await this.requireTaskProjectionReadable(client, principal, taskId);
      if (afterCursor > 0) {
        const cursor = await client.query(`SELECT 1 FROM business_task_events
          WHERE tenant_id=$1 AND business_task_id=$2 AND sequence=$3`, [principal.tenantId, taskId, afterCursor]);
        if (cursor.rowCount !== 1) {
          throw new GenewayError('EVENT_CURSOR_INVALID', 'Event cursor does not belong to this task', 409);
        }
      }
      const result = await client.query<{
        id: string;
        business_task_id: string;
        sequence: string;
        event_type: string;
        aggregate_version: string;
        payload: unknown;
        simulation: boolean;
        runtime_mode: string;
        business_decision_allowed: boolean;
        occurred_at: Date;
      }>(`SELECT id,business_task_id,sequence::text,event_type,aggregate_version::text,payload,
        simulation,runtime_mode,business_decision_allowed,occurred_at
        FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2 AND sequence>$3 ORDER BY sequence`, [principal.tenantId, taskId, afterCursor]);
      return result.rows.map((row) => this.projectTaskEvent(row));
    });
  }

  private projectTaskEvent(row: Readonly<{
    id: string;
    business_task_id: string;
    sequence: string;
    event_type: string;
    aggregate_version: string;
    payload: unknown;
    simulation: boolean;
    runtime_mode: string;
    business_decision_allowed: boolean;
    occurred_at: Date;
  }>): TaskEventProjection {
    const storedPayload = typeof row.payload === 'object' && row.payload !== null
      ? row.payload as Readonly<Record<string, unknown>>
      : {};
    const common = {
      cursor: Number(row.sequence),
      id: row.id,
      businessTaskId: row.business_task_id,
      sequence: Number(row.sequence),
      aggregateVersion: Number(row.aggregate_version),
      occurredAt: row.occurred_at.toISOString(),
      simulation: row.simulation,
      runtimeMode: row.runtime_mode,
      businessDecisionAllowed: row.business_decision_allowed,
    };
    let payload: Readonly<Record<string, unknown>>;
    switch (row.event_type) {
      case 'business_task.created':
        payload = {
          approvalId: storedPayload.approvalId,
          workflowVersionId: storedPayload.workflowVersionId,
          workflowHash: storedPayload.workflowHash,
        };
        break;
      case 'approval.decided':
        payload = { approvalId: storedPayload.approvalId, decision: storedPayload.decision };
        break;
      case 'workflow.execute.requested':
        payload = {
          workflowVersionId: storedPayload.workflowVersionId,
          workflowHash: storedPayload.workflowHash,
        };
        break;
      case 'workflow.step_started':
      case 'workflow.step_completed':
        payload = { stepId: storedPayload.stepId };
        break;
      case 'business_task.failed':
        payload = { code: storedPayload.code };
        break;
      case 'business_task.canceled':
        payload = { reasonCode: storedPayload.reasonCode };
        break;
      case 'workflow.run_started':
      case 'workflow.run_reclaimed':
      case 'business_task.completed':
        payload = {};
        break;
      default:
        throw new GenewayError('PUBLIC_TASK_EVENT_UNSUPPORTED', 'Stored task event is not safe for the public projection', 500);
    }
    return taskEventProjectionSchema.parse({ ...common, eventType: row.event_type, payload });
  }

  async decideApproval(principal: Principal, approvalId: string, decision: 'approved' | 'rejected', idempotencyKey: string): Promise<{ approvalId: string; status: string }> {
    return this.withTransaction((client) => this.idempotent(client, principal, 'approval.decide', idempotencyKey, { approvalId, decision }, async () => {
      await this.assertPlatformOperational(client);
      const result = await client.query<ApprovalRow>(`SELECT a.* FROM approval_versions a
        JOIN business_tasks t ON t.tenant_id=a.tenant_id AND t.id=a.business_task_id
        WHERE a.tenant_id=$1 AND a.id=$2 AND t.requester_id=$3 FOR UPDATE OF a,t`, [principal.tenantId, approvalId, principal.userId]);
      const approval = result.rows[0];
      if (approval === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Approval was not found', 404);
      const task = await this.requireTask(client, principal.tenantId, approval.business_task_id, principal.userId);
      await this.assertApprovalSubjectAuthority(client, approval, task);
      if (approval.expires_at.getTime() <= Date.now()) throw new GenewayError('APPROVAL_EXPIRED', 'Approval has expired', 409);
      if (approval.status !== 'pending') {
        if (approval.status === decision) return { approvalId, status: decision };
        throw new GenewayError('APPROVAL_TERMINAL', 'Approval is already terminal', 409);
      }
      const updated = await client.query(`UPDATE approval_versions SET status=$3,decision_by=$4,decision_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [principal.tenantId, approvalId, decision, principal.userId]);
      if (updated.rowCount !== 1) throw new GenewayError('APPROVAL_CAS_CONFLICT', 'Approval decision lost a compare-and-set race', 409);
      await client.query('UPDATE business_tasks SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2', [principal.tenantId, approval.business_task_id, decision === 'approved' ? 'approved' : 'rejected']);
      await this.appendEvent(client, principal.tenantId, approval.business_task_id, 'approval.decided', { approvalId, decision });
      return { approvalId, status: decision };
    }, async (response) => {
      const result = await client.query<ApprovalRow>('SELECT * FROM approval_versions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        principal.tenantId, response.approvalId,
      ]);
      const approval = result.rows[0];
      if (approval === undefined || approval.status !== response.status) {
        throw new GenewayError('APPROVAL_REPLAY_INVALID', 'Stored approval decision is no longer current', 409);
      }
      if (approval.expires_at.getTime() <= Date.now()) throw new GenewayError('APPROVAL_EXPIRED', 'Approval has expired', 409);
      const task = await this.requireTask(client, principal.tenantId, approval.business_task_id, principal.userId);
      await this.assertApprovalSubjectAuthority(client, approval, task);
    }));
  }

  async getApproval(principal: Principal, approvalId: string): Promise<ApprovalProjection> {
    return this.withTransaction(async (client) => {
      const result = await client.query<ApprovalRow>(`SELECT a.*
        FROM approval_versions a JOIN business_tasks t ON t.tenant_id=a.tenant_id AND t.id=a.business_task_id
        WHERE a.tenant_id=$1 AND a.id=$2 AND t.requester_id=$3`, [principal.tenantId, approvalId, principal.userId]);
      const row = result.rows[0];
      if (row === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Approval was not found', 404);
      const task = await this.requireTaskProjectionReadable(client, principal, row.business_task_id);
      this.assertApprovalProjectionIntegrity(row, task);
      return approvalProjectionSchema.parse({
        id: row.id,
        businessTaskId: row.business_task_id,
        version: row.version,
        subjectDigest: row.subject_digest,
        status: row.status,
      });
    });
  }

  async listWorkflows(principal: Principal, query: WorkflowListQuery): Promise<WorkflowListResponse> {
    return this.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const canonicalQuery = { capabilityVersionId: query.capabilityVersionId ?? null, limit: query.limit };
      const authorizationEpoch = await this.authorizationEpoch(client, principal);
      let snapshot: QuerySnapshotRow;
      let position = 0;

      if (query.cursor === undefined) {
        const candidates = await client.query<{ id: string; created_at: Date }>(`WITH readable_tasks AS (
          SELECT t.workflow_version_id,t.capability_version_id FROM business_tasks t
          WHERE t.tenant_id=$1 AND ${TASK_PROJECTION_AUTHORIZATION_SQL}
        )
          SELECT DISTINCT w.id,w.created_at FROM workflow_versions w JOIN readable_tasks task
            ON task.workflow_version_id=w.id
          WHERE w.tenant_id=$1 AND ($3::text IS NULL OR task.capability_version_id=$3)
          ORDER BY w.created_at DESC,w.id ASC`, [principal.tenantId, principal.userId, query.capabilityVersionId ?? null]);
        const readable: { id: string; createdAt: Date }[] = [];
        for (const candidate of candidates.rows) {
          try {
            await this.requireReadableWorkflow(client, principal, candidate.id);
            readable.push({ id: candidate.id, createdAt: candidate.created_at });
          } catch (error) {
            if (!this.isListVisibilityError(error) && (!isGenewayError(error) || error.code !== 'WORKFLOW_NOT_FOUND')) throw error;
          }
        }
        snapshot = await this.createQuerySnapshot(client, principal, {
          kind: 'workflow_versions',
          authorizationEpoch,
          canonicalQuery,
          queryVersion: WORKFLOW_LIST_QUERY_VERSION,
          fieldMaskVersion: WORKFLOW_LIST_FIELD_MASK_VERSION,
          items: readable.map((workflow) => ({
            objectId: workflow.id,
            sortKey: { value: workflow.createdAt.toISOString(), id: workflow.id },
          })),
        });
      } else {
        const cursor = this.parsePaginationCursor(query.cursor);
        position = cursor.position;
        snapshot = await this.requireQuerySnapshot(client, principal, cursor, {
          kind: 'workflow_versions',
          authorizationEpoch,
          canonicalQuery,
          queryVersion: WORKFLOW_LIST_QUERY_VERSION,
          fieldMaskVersion: WORKFLOW_LIST_FIELD_MASK_VERSION,
        });
      }

      const page = await this.readQuerySnapshotPage(client, principal, snapshot, position, query.limit, async (objectId) => {
        try {
          return this.projectWorkflowListItem(await this.requireReadableWorkflow(client, principal, objectId));
        } catch (error) {
          if (this.isListVisibilityError(error) || (isGenewayError(error) && error.code === 'WORKFLOW_NOT_FOUND')) return null;
          throw error;
        }
      });
      return workflowListResponseSchema.parse({
        workflows: page.items,
        nextCursor: page.nextCursor,
        asOf: snapshot.as_of.toISOString(),
        queryVersion: snapshot.query_version,
      });
    });
  }

  async getWorkflow(principal: Principal, workflowId: string): Promise<WorkflowDetailProjection> {
    return this.withTransaction(async (client) => this.projectWorkflowDetail(await this.requireReadableWorkflow(client, principal, workflowId)));
  }

  async enqueueExecution(principal: Principal, taskId: string, input: ExecuteTaskInput, idempotencyKey: string): Promise<ExecutionResponse> {
    return this.withTransaction((client) => this.idempotent(client, principal, 'business-task.execute', idempotencyKey, { taskId, ...input }, async () => {
      await this.assertPlatformOperational(client);
      const task = await this.requireTask(client, principal.tenantId, taskId, principal.userId);
      await this.assertApprovedExecutionAuthority(client, task, input);
      if (task.status === 'completed') return { taskId, status: 'completed' as const };
      if (task.status === 'queued' || task.status === 'running') return { taskId, status: 'accepted' as const };
      if (task.status !== 'approved') throw new GenewayError('TASK_EXECUTION_NOT_READY', `Task cannot be executed from state ${task.status}`, 409);
      const updated = await client.query(`UPDATE business_tasks SET status='queued',execution_version=execution_version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND requester_id=$3 AND status='approved'`, [principal.tenantId, taskId, principal.userId]);
      if (updated.rowCount !== 1) throw new GenewayError('TASK_STATE_CONFLICT', 'Task is not ready to queue', 409);
      await this.appendEvent(client, principal.tenantId, taskId, 'workflow.execute.requested', {
        workflowVersionId: task.workflow_version_id,
        workflowHash: task.workflow_hash,
      });
      return { taskId, status: 'accepted' as const };
    }, async (response) => {
      const task = await this.requireTask(client, principal.tenantId, response.taskId, principal.userId);
      await this.assertApprovedExecutionAuthority(client, task, input);
    }));
  }

  async assertPlatformOperational(client: Pick<PoolClient, 'query'> = this.pool): Promise<void> {
    const barrier = await client.query(
      'SELECT backup_set_id FROM platform_write_barriers WHERE active AND reads_blocked LIMIT 1',
    );
    if (barrier.rowCount !== 0) {
      throw new GenewayError('RESTORE_PLATFORM_GATE_ACTIVE', 'Platform execution is unavailable until restore verification completes', 503);
    }
  }

  async cancelTask(principal: Principal, taskId: string, idempotencyKey: string): Promise<CancellationResponse> {
    return this.withTransaction((client) => this.idempotent(client, principal, 'business-task.cancel', idempotencyKey, { taskId }, async () => {
      const task = await this.requireTask(client, principal.tenantId, taskId, principal.userId);
      if (task.status === 'canceled') return { taskId, status: 'canceled' as const };
      if (task.status !== 'queued' && task.status !== 'running') {
        throw new GenewayError('TASK_CANCEL_NOT_ALLOWED', `Task cannot be canceled from state ${task.status}`, 409);
      }

      const canceledResult = taskResultSchema.parse({
        kind: 'canceled',
        code: 'USER_CANCELED',
        message: '用户已取消模拟任务。',
        ...SIMULATION_ENVELOPE,
      });
      const nextFence = Number(task.execution_fencing_token) + 1;
      if (!Number.isSafeInteger(nextFence) || nextFence < 1) {
        throw new GenewayError('EXECUTION_FENCE_INVALID', 'Task execution fence is invalid', 500);
      }

      if (task.current_execution_attempt_id !== null) {
        const attempt = await client.query(`UPDATE execution_attempts SET status='canceled',completed_at=now(),
          last_error='USER_CANCELED' WHERE tenant_id=$1 AND id=$2 AND business_task_id=$3 AND status='running'`, [
          principal.tenantId, task.current_execution_attempt_id, taskId,
        ]);
        if (task.status === 'running' && attempt.rowCount !== 1) {
          throw new GenewayError('TASK_CANCEL_CAS_CONFLICT', 'Current execution attempt changed before cancellation', 409);
        }
        const delivery = await client.query(`UPDATE outbox_deliveries SET status='canceled',last_error='USER_CANCELED',
          lease_until=now(),updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2
          AND execution_attempt_id=$3 AND status='leased'`, [
          principal.tenantId, taskId, task.current_execution_attempt_id,
        ]);
        if (task.status === 'running' && delivery.rowCount !== 1) {
          throw new GenewayError('TASK_CANCEL_CAS_CONFLICT', 'Current delivery changed before cancellation', 409);
        }
        const inbox = await client.query(`UPDATE inbox_events SET status='canceled',processing_at=coalesce(processing_at,now()),
          completed_at=now(),last_error='USER_CANCELED' WHERE tenant_id=$1 AND business_task_id=$2
          AND execution_attempt_id=$3 AND status IN ('received','processing')`, [
          principal.tenantId, taskId, task.current_execution_attempt_id,
        ]);
        if (task.status === 'running' && inbox.rowCount !== 1) {
          throw new GenewayError('TASK_CANCEL_CAS_CONFLICT', 'Current inbox receipt changed before cancellation', 409);
        }
      }

      await client.query(`UPDATE business_task_steps SET status='canceled',lease_until=null,updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND status IN ('queued','running')`, [principal.tenantId, taskId]);
      await client.query(`UPDATE report_publish_intents SET status='reconcile_required',state_version=state_version+1,
        failure_code='TASK_CANCELED',updated_at=now() WHERE tenant_id=$1 AND business_task_id=$2
        AND status IN ('prepared','object_verified')`, [principal.tenantId, taskId]);
      const canceled = await client.query(`UPDATE business_tasks SET status='canceled',result=$4,
        execution_fencing_token=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND requester_id=$3
        AND status IN ('queued','running') AND execution_fencing_token=$6`, [
        principal.tenantId, taskId, principal.userId, canceledResult, nextFence, Number(task.execution_fencing_token),
      ]);
      if (canceled.rowCount !== 1) throw new GenewayError('TASK_CANCEL_CAS_CONFLICT', 'Cancellation lost the terminal compare-and-set race', 409);
      await this.appendEvent(client, principal.tenantId, taskId, 'business_task.canceled', {
        reasonCode: 'USER_CANCELED',
        executionFencingToken: nextFence,
      });
      return { taskId, status: 'canceled' as const };
    }, async (response) => {
      const task = await this.requireTask(client, principal.tenantId, response.taskId, principal.userId);
      if (task.status !== 'canceled') throw new GenewayError('TASK_CANCEL_REPLAY_INVALID', 'Stored cancellation is no longer current', 409);
    }));
  }

  async getClaim(principal: Principal, claimId: string): Promise<JsonObject> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`SELECT c.* FROM claims c JOIN business_tasks t
      ON t.tenant_id=c.tenant_id AND t.id=c.business_task_id
      LEFT JOIN evidence_links l ON l.tenant_id=c.tenant_id AND l.claim_id=c.id AND l.relation='supports'
      LEFT JOIN evidence_items e ON e.tenant_id=l.tenant_id AND e.id=l.evidence_id
      WHERE c.tenant_id=$1 AND c.id=$2 AND t.requester_id=$3
        AND (c.status='rejected' OR (e.accessible AND (e.source_kind='legacy_fixture' OR EXISTS (
          SELECT 1 FROM document_snapshots current_snapshot
          JOIN artifact_states current_state ON current_state.tenant_id=current_snapshot.tenant_id AND current_state.artifact_id=current_snapshot.artifact_id
          WHERE current_snapshot.tenant_id=e.tenant_id
            AND current_snapshot.id=e.source->>'documentSnapshotId'
            AND current_snapshot.artifact_id=e.source->>'artifactId'
            AND current_snapshot.content_sha256=e.source->>'snapshotSha256'
            AND current_state.availability='active' AND current_state.integrity='verified'
            AND current_state.retention_status='active' AND current_state.retention_expires_at>now()
            AND current_state.reconcile_status='in_sync'
        ) OR (e.source_kind='business_exception_snapshot' AND EXISTS (
          SELECT 1 FROM business_exception_source_snapshots source_snapshot
          JOIN business_exception_analysis_bindings source_binding
            ON source_binding.tenant_id=source_snapshot.tenant_id
            AND source_binding.source_version_id=source_snapshot.source_version_id
          JOIN resource_scopes readable_scope ON readable_scope.tenant_id=source_snapshot.tenant_id
            AND readable_scope.user_id=$3
          WHERE source_snapshot.tenant_id=e.tenant_id
            AND source_snapshot.business_exception_id=e.source->>'businessExceptionId'
            AND source_snapshot.source_version_id=e.source->>'sourceVersionId'
            AND source_snapshot.canonical_sha256=e.source->>'sourceSha256'
            AND source_snapshot.resource_scope=e.resource_scope AND source_snapshot.data_class=e.data_class
            AND source_binding.business_task_id=e.business_task_id
            AND source_binding.requester_principal_id=$3
            AND e.audience='conversation:' || source_binding.private_conversation_id
            AND (source_snapshot.resource_scope=readable_scope.resource_scope
              OR source_snapshot.resource_scope LIKE readable_scope.resource_scope || '/%')
        )))))`, [principal.tenantId, claimId, principal.userId]);
      const row = result.rows[0] as (JsonObject & Readonly<{ business_task_id: string }>) | undefined;
      if (row === undefined) throw new GenewayError('CLAIM_NOT_FOUND', 'Claim was not found', 404);
      await this.requireReadableTask(client, principal, row.business_task_id);
      return row;
    });
  }

  async getEvidenceMetadata(principal: Principal, evidenceId: string): Promise<JsonObject> {
    return this.withTransaction(async (client) => {
      const result = await client.query(`SELECT e.* FROM evidence_items e JOIN business_tasks t
      ON t.tenant_id=e.tenant_id AND t.id=e.business_task_id
      WHERE e.tenant_id=$1 AND e.id=$2 AND e.accessible AND t.requester_id=$3
        AND (e.source_kind='legacy_fixture' OR EXISTS (
          SELECT 1 FROM document_snapshots current_snapshot
          JOIN artifact_states current_state ON current_state.tenant_id=current_snapshot.tenant_id AND current_state.artifact_id=current_snapshot.artifact_id
          WHERE current_snapshot.tenant_id=e.tenant_id
            AND current_snapshot.id=e.source->>'documentSnapshotId'
            AND current_snapshot.artifact_id=e.source->>'artifactId'
            AND current_snapshot.content_sha256=e.source->>'snapshotSha256'
            AND current_snapshot.resource_scope=e.resource_scope
            AND current_snapshot.data_class=e.data_class
            AND e.audience='conversation:' || current_snapshot.conversation_id
            AND current_state.availability='active' AND current_state.integrity='verified'
            AND current_state.retention_status='active' AND current_state.retention_expires_at>now()
            AND current_state.reconcile_status='in_sync'
        ) OR (e.source_kind='business_exception_snapshot' AND EXISTS (
          SELECT 1 FROM business_exception_source_snapshots source_snapshot
          JOIN business_exception_analysis_bindings source_binding
            ON source_binding.tenant_id=source_snapshot.tenant_id
            AND source_binding.source_version_id=source_snapshot.source_version_id
          JOIN resource_scopes readable_scope ON readable_scope.tenant_id=source_snapshot.tenant_id
            AND readable_scope.user_id=$3
          WHERE source_snapshot.tenant_id=e.tenant_id
            AND source_snapshot.business_exception_id=e.source->>'businessExceptionId'
            AND source_snapshot.source_version_id=e.source->>'sourceVersionId'
            AND source_snapshot.canonical_sha256=e.source->>'sourceSha256'
            AND source_snapshot.resource_scope=e.resource_scope AND source_snapshot.data_class=e.data_class
            AND source_binding.business_task_id=e.business_task_id
            AND source_binding.requester_principal_id=$3
            AND e.audience='conversation:' || source_binding.private_conversation_id
            AND (source_snapshot.resource_scope=readable_scope.resource_scope
              OR source_snapshot.resource_scope LIKE readable_scope.resource_scope || '/%')
        )))`, [principal.tenantId, evidenceId, principal.userId]);
      const row = result.rows[0] as (JsonObject & Readonly<{ business_task_id: string }>) | undefined;
      if (row === undefined) throw new GenewayError('EVIDENCE_NOT_FOUND', 'Evidence was not found', 404);
      await this.requireReadableTask(client, principal, row.business_task_id);
      return row;
    });
  }

  private async resolveInput(client: PoolClient, principal: Principal, input: CreateTaskInput): Promise<ResolvedTaskInputRef> {
    if (input.inputRef.kind === 'fixture') return { kind: 'fixture', fixtureRef: FIXTURE_REF, fixtureVersion: FIXTURE_VERSION };
    const result = await client.query<{
      id: string;
      artifact_id: string;
      manifest_id: string;
      content_sha256: string;
      simulation_profile: 'solution-analysis-demo/v2' | null;
      profile_registry_version: 'gate0.2a-profile-registry/1';
      resource_scope: string;
      data_class: 'C1';
      conversation_id: string;
      audience: unknown;
      availability: string;
      integrity: string;
      retention_status: string;
      retention_expires_at: Date;
      reconcile_status: string;
    }>(`SELECT d.*,s.availability,s.integrity,s.retention_status,s.retention_expires_at,s.reconcile_status
      FROM document_snapshots d JOIN artifacts a ON a.tenant_id=d.tenant_id AND a.id=d.artifact_id
      JOIN artifact_states s ON s.tenant_id=d.tenant_id AND s.artifact_id=d.artifact_id
      WHERE d.tenant_id=$1 AND d.id=$2 AND d.conversation_id=$3 AND d.created_by=$4 AND a.owner_user_id=$4 FOR SHARE`, [
      principal.tenantId, input.inputRef.documentSnapshotId, input.conversationId, principal.userId,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('DOCUMENT_SNAPSHOT_NOT_FOUND', 'Document snapshot was not found', 404);
    if (row.simulation_profile !== 'solution-analysis-demo/v2') {
      throw new GenewayError('NOT_OPEN_FOR_SIMULATION_PROFILE', 'This document is stored but is not open for the current simulation profile', 422);
    }
    if (row.profile_registry_version !== 'gate0.2a-profile-registry/1') throw new GenewayError('SIMULATION_PROFILE_VERSION_MISMATCH', 'Document profile registry version is not supported', 409);
    if (row.availability !== 'active' || row.integrity !== 'verified' || row.retention_status !== 'active'
      || row.retention_expires_at.getTime() <= Date.now() || row.reconcile_status !== 'in_sync') {
      throw new GenewayError('DOCUMENT_SNAPSHOT_NOT_READY', 'Document snapshot is not currently eligible for execution', 409);
    }
    const audience = row.audience as Readonly<{ kind?: unknown; conversationId?: unknown }>;
    if (row.data_class !== 'C1' || row.resource_scope !== `artifact:${row.artifact_id}`
      || audience.kind !== 'private-conversation' || audience.conversationId !== row.conversation_id) {
      throw new GenewayError('DOCUMENT_SNAPSHOT_POLICY_DENIED', 'Document snapshot policy metadata is invalid', 403);
    }
    return resolvedTaskInputRefSchema.parse({
      kind: 'document_snapshot',
      documentSnapshotId: row.id,
      artifactId: row.artifact_id,
      manifestId: row.manifest_id,
      contentSha256: row.content_sha256,
      simulationProfile: row.simulation_profile,
      profileRegistryVersion: row.profile_registry_version,
      resourceScope: row.resource_scope,
      dataClass: row.data_class,
      audience: `conversation:${row.conversation_id}`,
    });
  }

  private async assertDocumentInputReady(client: PoolClient, principal: Principal, input: ResolvedTaskInputRef): Promise<void> {
    if (input.kind !== 'document_snapshot') return;
    const result = await client.query(`SELECT 1 FROM document_snapshots d
      JOIN artifacts a ON a.tenant_id=d.tenant_id AND a.id=d.artifact_id
      JOIN artifact_states s ON s.tenant_id=d.tenant_id AND s.artifact_id=d.artifact_id
      WHERE d.tenant_id=$1 AND d.id=$2 AND d.created_by=$3 AND a.owner_user_id=$3
        AND d.artifact_id=$4 AND d.manifest_id=$5 AND d.content_sha256=$6
        AND d.simulation_profile=$7 AND d.profile_registry_version=$8 AND d.resource_scope=$9
        AND d.data_class=$10 AND ('conversation:' || d.conversation_id)=$11
        AND d.audience=jsonb_build_object('kind','private-conversation','conversationId',d.conversation_id)
        AND s.availability='active' AND s.integrity='verified' AND s.retention_status='active'
        AND s.retention_expires_at>now() AND s.reconcile_status='in_sync'`, [
      principal.tenantId, input.documentSnapshotId, principal.userId, input.artifactId, input.manifestId,
      input.contentSha256, input.simulationProfile, input.profileRegistryVersion, input.resourceScope,
      input.dataClass, input.audience,
    ]);
    if (result.rowCount !== 1) throw new GenewayError('DOCUMENT_SNAPSHOT_NOT_READY', 'Approved document snapshot is no longer execution-ready', 409);
  }

  private async assertExceptionInputReady(
    client: PoolClient,
    principal: Principal,
    task: TaskRow,
    input: ResolvedTaskInputRef,
  ): Promise<void> {
    if (input.kind !== 'business_exception_snapshot') return;
    const result = await client.query(`SELECT 1
      FROM business_exception_source_snapshots snapshot
      JOIN business_exception_analysis_bindings binding
        ON binding.tenant_id=snapshot.tenant_id AND binding.source_version_id=snapshot.source_version_id
      WHERE snapshot.tenant_id=$1 AND snapshot.business_exception_id=$2 AND snapshot.source_version_id=$3
        AND snapshot.canonical_sha256=$4 AND snapshot.canonicalization_version=$5
        AND snapshot.fixture_version=$6 AND snapshot.source_system=$7 AND snapshot.source_object_ref=$8
        AND snapshot.detection_window=$9 AND snapshot.resource_scope=$10 AND snapshot.data_class=$11
        AND snapshot.audience=$12 AND binding.business_task_id=$13
        AND binding.requester_principal_id=$14 AND binding.private_conversation_id=$15
        AND binding.task_audience=$16
        AND EXISTS (SELECT 1 FROM roles role_binding WHERE role_binding.tenant_id=snapshot.tenant_id
          AND role_binding.user_id=$14 AND role_binding.role='solution_reviewer')
        AND EXISTS (SELECT 1 FROM resource_scopes readable_scope WHERE readable_scope.tenant_id=snapshot.tenant_id
          AND readable_scope.user_id=$14 AND (snapshot.resource_scope=readable_scope.resource_scope
            OR snapshot.resource_scope LIKE readable_scope.resource_scope || '/%'))`, [
      principal.tenantId, input.businessExceptionId, input.sourceVersionId, input.sourceSha256,
      input.canonicalizationVersion, input.fixtureVersion, input.sourceSystem, input.sourceObjectRef,
      input.detectionWindow, input.resourceScope, input.dataClass, input.sourceAudience,
      task.id, principal.userId, task.conversation_id, input.taskAudience,
    ]);
    if (result.rowCount !== 1) {
      throw new GenewayError('BUSINESS_EXCEPTION_SOURCE_NOT_READY', 'Approved exception source is no longer readable', 409);
    }
  }

  private capabilityIdForTask(task: TaskRow): 'solution.analysis.v1' | 'operations.exception-assist.v1' {
    if (task.capability_version_id === EXCEPTION_ASSIST_CAPABILITY_VERSION_ID) return 'operations.exception-assist.v1';
    if (task.capability_version_id !== SOLUTION_CAPABILITY_VERSION_ID) {
      throw new GenewayError('TASK_CAPABILITY_UNSUPPORTED', 'Task capability is not available in this product projection', 500);
    }
    return 'solution.analysis.v1';
  }

  private async projectTaskListItem(client: PoolClient, task: TaskRow) {
    const approvalResult = await client.query<ApprovalRow>(`SELECT * FROM approval_versions
      WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY version DESC LIMIT 1`, [task.tenant_id, task.id]);
    const approval = approvalResult.rows[0];
    if (approval === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Task has no approval version', 500);
    return taskListItemSchema.parse({
      id: task.id,
      capabilityId: this.capabilityIdForTask(task),
      status: task.status,
      title: this.capabilityIdForTask(task) === 'operations.exception-assist.v1' ? '异常分析' : '方案分析',
      conversationId: task.conversation_id,
      workflowVersion: { id: task.workflow_version_id, hash: task.workflow_hash },
      approvalStatus: approval.status,
      createdAt: task.created_at.toISOString(),
      updatedAt: task.updated_at.toISOString(),
      aggregateVersion: Number(task.aggregate_version),
      simulation: task.simulation,
    });
  }

  private async requireReadableWorkflow(client: PoolClient, principal: Principal, workflowId: string): Promise<WorkflowVersionRow> {
    const candidates = await client.query<{ id: string }>(`SELECT id FROM business_tasks
      WHERE tenant_id=$1 AND workflow_version_id=$2 AND requester_id=$3 ORDER BY created_at,id`, [
      principal.tenantId, workflowId, principal.userId,
    ]);
    let readable = false;
    for (const candidate of candidates.rows) {
      try {
        await this.requireTaskProjectionReadable(client, principal, candidate.id);
        readable = true;
        break;
      } catch (error) {
        if (!this.isListVisibilityError(error)) throw error;
      }
    }
    if (!readable) throw new GenewayError('WORKFLOW_NOT_FOUND', 'Workflow was not found', 404);
    const result = await client.query<WorkflowVersionRow>(`SELECT id,workflow_hash,canonicalization_version,
      canonical_json,created_at FROM workflow_versions WHERE tenant_id=$1 AND id=$2`, [principal.tenantId, workflowId]);
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('WORKFLOW_NOT_FOUND', 'Workflow was not found', 404);
    return row;
  }

  private projectWorkflowListItem(row: WorkflowVersionRow) {
    const workflow = readStoredWorkflowVersion({
      id: row.id,
      hash: row.workflow_hash,
      canonicalizationVersion: row.canonicalization_version,
      canonicalPayload: row.canonical_json,
    });
    return workflowListItemSchema.parse({
      id: workflow.id,
      hash: workflow.hash,
      capabilityVersionId: workflow.payload.capabilityVersionId,
      harnessVersionId: workflow.payload.harnessVersionId,
      createdAt: row.created_at.toISOString(),
      simulation: true,
    });
  }

  private projectWorkflowDetail(row: WorkflowVersionRow): WorkflowDetailProjection {
    const workflow = readStoredWorkflowVersion({
      id: row.id,
      hash: row.workflow_hash,
      canonicalizationVersion: row.canonicalization_version,
      canonicalPayload: row.canonical_json,
    });
    return workflowDetailProjectionSchema.parse({
      ...this.projectWorkflowListItem(row),
      compilerVersion: workflow.payload.compilerVersion,
      canonicalizationVersion: workflow.payload.canonicalizationVersion,
      featureSet: workflow.payload.featureSet,
      nodes: workflow.payload.nodes,
      edges: workflow.payload.edges,
      permissionCeiling: workflow.payload.permissionCeiling,
    });
  }

  private isListVisibilityError(error: unknown): boolean {
    return isGenewayError(error) && ['TASK_NOT_FOUND', 'DOCUMENT_SNAPSHOT_NOT_READY', 'TASK_POLICY_CONTEXT_INVALID'].includes(error.code);
  }

  private async authorizationEpoch(client: PoolClient, principal: Principal): Promise<string> {
    const user = await client.query('SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2', [principal.tenantId, principal.userId]);
    if (user.rowCount !== 1) throw new GenewayError('PRINCIPAL_NOT_FOUND', 'Principal is not available', 403);
    const roles = await client.query<{ role: string }>('SELECT role FROM roles WHERE tenant_id=$1 AND user_id=$2 ORDER BY role', [principal.tenantId, principal.userId]);
    const scopes = await client.query<{ resource_scope: string }>('SELECT resource_scope FROM resource_scopes WHERE tenant_id=$1 AND user_id=$2 ORDER BY resource_scope', [principal.tenantId, principal.userId]);
    return hashCanonical({
      tenantId: principal.tenantId,
      userId: principal.userId,
      trust: principal.trust,
      policyVersion: 'task-projection-read/v1',
      roles: roles.rows.map((row) => row.role),
      resourceScopes: scopes.rows.map((row) => row.resource_scope),
    });
  }

  private async createQuerySnapshot(
    client: PoolClient,
    principal: Principal,
    input: Readonly<{
      kind: QuerySnapshotRow['query_kind'];
      authorizationEpoch: string;
      canonicalQuery: JsonObject;
      queryVersion: string;
      fieldMaskVersion: string;
      items: readonly Readonly<{ objectId: string; sortKey: JsonObject }>[];
    }>,
  ): Promise<QuerySnapshotRow> {
    await client.query('DELETE FROM query_snapshots WHERE expires_at<=now()');
    const clock = await client.query<{ as_of: Date }>('SELECT transaction_timestamp() as_of');
    const asOf = clock.rows[0]?.as_of;
    if (asOf === undefined) throw new GenewayError('QUERY_SNAPSHOT_FAILED', 'Could not establish a query snapshot time', 500);
    const snapshot: QuerySnapshotRow = {
      id: id('query'),
      query_kind: input.kind,
      authorization_epoch: input.authorizationEpoch,
      canonical_query: input.canonicalQuery,
      query_version: input.queryVersion,
      field_mask_version: input.fieldMaskVersion,
      as_of: asOf,
      expires_at: new Date(asOf.getTime() + QUERY_SNAPSHOT_TTL_MS),
    };
    await client.query(`INSERT INTO query_snapshots
      (tenant_id,id,principal_id,query_kind,authorization_epoch,canonical_query,query_version,field_mask_version,as_of,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      principal.tenantId, snapshot.id, principal.userId, snapshot.query_kind, snapshot.authorization_epoch,
      snapshot.canonical_query, snapshot.query_version, snapshot.field_mask_version, snapshot.as_of, snapshot.expires_at,
    ]);
    for (const [position, item] of input.items.entries()) {
      await client.query(`INSERT INTO query_snapshot_items
        (tenant_id,query_snapshot_id,position,object_id,sort_key) VALUES ($1,$2,$3,$4,$5)`, [
        principal.tenantId, snapshot.id, position, item.objectId, item.sortKey,
      ]);
    }
    return snapshot;
  }

  private async requireQuerySnapshot(
    client: PoolClient,
    principal: Principal,
    cursor: PaginationCursorPayload,
    expected: Readonly<{
      kind: QuerySnapshotRow['query_kind'];
      authorizationEpoch: string;
      canonicalQuery: JsonObject;
      queryVersion: string;
      fieldMaskVersion: string;
    }>,
  ): Promise<QuerySnapshotRow> {
    const result = await client.query<QuerySnapshotRow>(`SELECT id,query_kind,authorization_epoch,canonical_query,
      query_version,field_mask_version,as_of,expires_at FROM query_snapshots
      WHERE tenant_id=$1 AND id=$2 AND principal_id=$3`, [principal.tenantId, cursor.snapshotId, principal.userId]);
    const snapshot = result.rows[0];
    if (snapshot === undefined
      || snapshot.query_kind !== expected.kind
      || snapshot.authorization_epoch !== expected.authorizationEpoch
      || hashCanonical(snapshot.canonical_query) !== hashCanonical(expected.canonicalQuery)
      || snapshot.query_version !== expected.queryVersion
      || snapshot.field_mask_version !== expected.fieldMaskVersion
      || snapshot.expires_at.getTime() <= Date.now()
      || snapshot.expires_at.getTime() !== cursor.expiresAt) {
      throw new GenewayError('CURSOR_INVALID', 'Pagination cursor is invalid or expired', 409);
    }
    return snapshot;
  }

  private async readQuerySnapshotPage<T>(
    client: PoolClient,
    principal: Principal,
    snapshot: QuerySnapshotRow,
    position: number,
    limit: number,
    project: (objectId: string) => Promise<T | null>,
  ): Promise<Readonly<{ items: readonly T[]; nextCursor: string | null }>> {
    const items: T[] = [];
    let scanPosition = position;
    let nextVisiblePosition: number | null = null;
    const scanBatchSize = 100;

    scan: while (true) {
      const rows = await client.query<{ position: number; object_id: string }>(`SELECT position,object_id
        FROM query_snapshot_items WHERE tenant_id=$1 AND query_snapshot_id=$2 AND position>=$3
        ORDER BY position LIMIT $4`, [principal.tenantId, snapshot.id, scanPosition, scanBatchSize]);
      if (rows.rows.length === 0) break;
      for (const row of rows.rows) {
        scanPosition = row.position + 1;
        const item = await project(row.object_id);
        if (item === null) continue;
        if (items.length < limit) items.push(item);
        else {
          nextVisiblePosition = row.position;
          break scan;
        }
      }
      if (rows.rows.length < scanBatchSize) break;
    }
    return {
      items,
      nextCursor: nextVisiblePosition === null
        ? null
        : this.issuePaginationCursor(snapshot.id, nextVisiblePosition, snapshot.expires_at.getTime()),
    };
  }

  private issuePaginationCursor(snapshotId: string, position: number, expiresAt: number): string {
    const encoded = Buffer.from(JSON.stringify({ snapshotId, position, expiresAt }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.cursorHmacSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private parsePaginationCursor(cursor: string): PaginationCursorPayload {
    const [encoded, signature, extra] = cursor.split('.');
    if (encoded === undefined || signature === undefined || extra !== undefined) {
      throw new GenewayError('CURSOR_INVALID', 'Pagination cursor is invalid or expired', 409);
    }
    try {
      const canonicalBase64Url = /^[A-Za-z0-9_-]+$/u;
      if (!canonicalBase64Url.test(encoded) || !canonicalBase64Url.test(signature)) throw new Error('invalid cursor encoding');
      const encodedBytes = Buffer.from(encoded, 'base64url');
      const actual = Buffer.from(signature, 'base64url');
      if (encodedBytes.toString('base64url') !== encoded || actual.toString('base64url') !== signature) {
        throw new Error('non-canonical cursor encoding');
      }
      const expected = createHmac('sha256', this.cursorHmacSecret).update(encoded).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid cursor signature');
      const value = JSON.parse(encodedBytes.toString('utf8')) as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'expiresAt,position,snapshotId'
        || typeof value.snapshotId !== 'string' || value.snapshotId.length === 0
        || !Number.isSafeInteger(value.position) || Number(value.position) < 0
        || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Date.now()) {
        throw new Error('invalid cursor payload');
      }
      return { snapshotId: value.snapshotId, position: Number(value.position), expiresAt: Number(value.expiresAt) };
    } catch {
      throw new GenewayError('CURSOR_INVALID', 'Pagination cursor is invalid or expired', 409);
    }
  }

  private async ensureVersions(client: PoolClient, tenantId: string, workflow: CompiledWorkflowVersion): Promise<{ expertCatalogVersionId: string }> {
    const expertCatalogVersionId = 'expert_catalog_solution_v1_1';
    await client.query(`INSERT INTO capability_versions (tenant_id,id,capability_id,version,spec)
      VALUES ($1,$2,'solution.analysis.v1',1,$3) ON CONFLICT DO NOTHING`, [tenantId, SOLUTION_CAPABILITY_VERSION_ID, { allowedExpertIds: ['expert.solution.architect'], allowedTeamIds: ['team.solution.core'], actionCeiling: 'A1' }]);
    await client.query('INSERT INTO expert_catalog_versions (tenant_id,id,version,catalog) VALUES ($1,$2,1,$3) ON CONFLICT DO NOTHING', [tenantId, expertCatalogVersionId, {
      experts: [{ id: 'expert.solution.architect', name: '方案专家', healthy: true }],
      teams: [{ id: 'team.solution.core', name: '方案专家团', expertIds: ['expert.solution.architect'], healthy: true }],
    }]);
    await client.query('INSERT INTO harness_versions (tenant_id,id,capability_version_id,version,spec) VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING', [tenantId, SOLUTION_HARNESS_VERSION_ID, SOLUTION_CAPABILITY_VERSION_ID, { runtime: 'fake', verifier: 'claim-evidence-minimum/1', maxSteps: 7 }]);
    await client.query('INSERT INTO workflow_versions (tenant_id,id,workflow_hash,canonicalization_version,canonical_json) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [tenantId, workflow.id, workflow.hash, workflow.canonicalizationVersion, JSON.parse(workflow.canonicalJson) as unknown]);
    return { expertCatalogVersionId };
  }

  private resolveExpertTarget(target: CreateTaskInput['expertTarget']): JsonObject {
    if (target.mode === 'auto') return { mode: 'expert', expertId: 'expert.solution.architect', resolution: 'automatic' };
    if (target.mode === 'expert' && target.expertId === 'expert.solution.architect') return { ...target, resolution: 'explicit' };
    if (target.mode === 'team' && target.teamId === 'team.solution.core') return { ...target, resolution: 'explicit' };
    throw new GenewayError('EXPERT_NOT_ALLOWED', 'Expert or expert team is outside the capability allowlist', 422);
  }

  private subjectFromTask(task: TaskRow, taskId: string): JsonObject {
    return buildApprovalSubject({
      taskId,
      requesterId: task.requester_id,
      inputSnapshot: normalizeStoredInput(task.input_snapshot),
      inputDigest: task.input_digest,
      expertTarget: task.expert_target,
      expertCatalogVersionId: task.expert_catalog_version_id,
      harnessVersionId: task.harness_version_id,
      workflowVersionId: task.workflow_version_id,
      workflowHash: task.workflow_hash,
      permissionScope: task.permission_scope,
      audienceScope: task.audience_scope,
      budget: task.budget,
    });
  }

  private async assertConversationOwned(client: PoolClient, principal: Principal, conversationId: string): Promise<void> {
    const result = await client.query('SELECT 1 FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [principal.tenantId, conversationId, principal.userId]);
    if (result.rowCount !== 1) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found', 404);
  }

  private async requireTask(client: PoolClient, tenantId: string, taskId: string, requesterId?: string): Promise<TaskRow> {
    const result = await client.query<TaskRow>(`SELECT * FROM business_tasks WHERE tenant_id=$1 AND id=$2
      AND ($3::text IS NULL OR requester_id=$3) FOR UPDATE`, [tenantId, taskId, requesterId ?? null]);
    const task = result.rows[0];
    if (task === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Task was not found', 404);
    return task;
  }

  private assertTaskProjectionContext(task: TaskRow): void {
    const inputRef = normalizeStoredInput(task.input_snapshot);
    const resourceScope = inputRef.kind === 'fixture' ? inputRef.fixtureRef : inputRef.resourceScope;
    const expectedPermissionScope = {
      actions: ['R0', 'R1', 'A1'], resourceScopes: [resourceScope],
      dataClasses: inputRef.kind === 'business_exception_snapshot' ? ['C1'] : ['C0', 'C1'],
    };
    const expectedAudienceScope = { kind: 'private-conversation', ids: [`conversation:${task.conversation_id}`] };
    if (hashCanonical(task.permission_scope) !== hashCanonical(expectedPermissionScope)
      || hashCanonical(task.audience_scope) !== hashCanonical(expectedAudienceScope)
      || (inputRef.kind === 'document_snapshot' && inputRef.audience !== `conversation:${task.conversation_id}`)
      || (inputRef.kind === 'business_exception_snapshot'
        && inputRef.taskAudience.conversationId !== task.conversation_id)) {
      throw new GenewayError('TASK_POLICY_CONTEXT_INVALID', 'Task policy context no longer matches its immutable input', 403);
    }
  }

  private async requireTaskProjectionReadable(client: PoolClient, principal: Principal, taskId: string): Promise<TaskRow> {
    const result = await client.query<TaskRow>(`SELECT t.* FROM business_tasks t
      WHERE t.tenant_id=$1 AND t.id=$3 AND ${TASK_PROJECTION_AUTHORIZATION_SQL}`, [
      principal.tenantId, principal.userId, taskId,
    ]);
    const task = result.rows[0];
    if (task === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Task was not found', 404);
    this.assertTaskProjectionContext(task);
    await this.assertTaskProjectionIntegrity(client, task);
    return task;
  }

  private async assertTaskProjectionIntegrity(client: PoolClient, task: TaskRow): Promise<void> {
    const workflowResult = await client.query<WorkflowVersionRow>(`SELECT id,workflow_hash,canonicalization_version,
      canonical_json,created_at FROM workflow_versions WHERE tenant_id=$1 AND id=$2`, [task.tenant_id, task.workflow_version_id]);
    const workflowRow = workflowResult.rows[0];
    if (workflowRow === undefined) throw new GenewayError('TASK_WORKFLOW_BINDING_INVALID', 'Task workflow binding is unavailable', 409);
    const workflow = readStoredWorkflowVersion({
      id: workflowRow.id,
      hash: workflowRow.workflow_hash,
      canonicalizationVersion: workflowRow.canonicalization_version,
      canonicalPayload: workflowRow.canonical_json,
    });
    if (workflow.id !== task.workflow_version_id || workflow.hash !== task.workflow_hash) {
      throw new GenewayError('TASK_WORKFLOW_BINDING_INVALID', 'Task workflow binding no longer matches the immutable version', 409);
    }
    const approvalResult = await client.query<ApprovalRow>(`SELECT * FROM approval_versions
      WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY version DESC LIMIT 1`, [task.tenant_id, task.id]);
    const approval = approvalResult.rows[0];
    if (approval === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Task has no approval version', 500);
    this.assertApprovalProjectionIntegrity(approval, task);
  }

  private assertApprovalProjectionIntegrity(approval: ApprovalRow, task: TaskRow): void {
    if (approval.business_task_id !== task.id || approval.requester_id !== task.requester_id
      || hashCanonical(approval.subject) !== approval.subject_digest
      || hashCanonical(this.subjectFromTask(task, task.id)) !== approval.subject_digest) {
      throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approval projection no longer matches task semantics', 409);
    }
  }

  private async requireReadableTask(client: PoolClient, principal: Principal, taskId: string): Promise<TaskRow> {
    const result = await client.query<TaskRow>('SELECT * FROM business_tasks WHERE tenant_id=$1 AND id=$2 AND requester_id=$3', [
      principal.tenantId, taskId, principal.userId,
    ]);
    const task = result.rows[0];
    if (task === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Task was not found', 404);
    const inputRef = normalizeStoredInput(task.input_snapshot);
    const resourceScope = inputRef.kind === 'fixture' ? inputRef.fixtureRef : inputRef.resourceScope;
    const expectedPermissionScope = {
      actions: ['R0', 'R1', 'A1'], resourceScopes: [resourceScope],
      dataClasses: inputRef.kind === 'business_exception_snapshot' ? ['C1'] : ['C0', 'C1'],
    };
    const expectedAudienceScope = { kind: 'private-conversation', ids: [`conversation:${task.conversation_id}`] };
    if (hashCanonical(task.permission_scope) !== hashCanonical(expectedPermissionScope)
      || hashCanonical(task.audience_scope) !== hashCanonical(expectedAudienceScope)
      || (inputRef.kind === 'document_snapshot' && inputRef.audience !== `conversation:${task.conversation_id}`)
      || (inputRef.kind === 'business_exception_snapshot'
        && inputRef.taskAudience.conversationId !== task.conversation_id)) {
      throw new GenewayError('TASK_POLICY_CONTEXT_INVALID', 'Task policy context no longer matches its immutable input', 403);
    }
    if (inputRef.kind === 'document_snapshot') await this.assertDocumentInputReady(client, principal, inputRef);
    if (inputRef.kind === 'business_exception_snapshot') await this.assertExceptionInputReady(client, principal, task, inputRef);
    return task;
  }

  private async assertDelegatedCapability(client: PoolClient, task: TaskRow): Promise<void> {
    const result = await client.query<{
      principal_id: string;
      allowed_actions: unknown;
      resource_scopes: unknown;
      audience_scope: unknown;
      expires_at: Date;
    }>('SELECT principal_id,allowed_actions,resource_scopes,audience_scope,expires_at FROM delegated_capabilities WHERE tenant_id=$1 AND business_task_id=$2 FOR SHARE', [
      task.tenant_id,
      task.id,
    ]);
    const row = result.rows[0];
    const permissionScope = task.permission_scope as Readonly<{ actions?: unknown; resourceScopes?: unknown }>;
    const audienceScope = task.audience_scope as Readonly<{ ids?: unknown }>;
    if (row === undefined || result.rowCount !== 1 || row.principal_id !== task.requester_id || row.expires_at.getTime() <= Date.now()
      || hashCanonical(row.allowed_actions) !== hashCanonical(permissionScope.actions)
      || hashCanonical(row.resource_scopes) !== hashCanonical(permissionScope.resourceScopes)
      || hashCanonical(row.audience_scope) !== hashCanonical(audienceScope.ids)) {
      throw new GenewayError('DELEGATED_CAPABILITY_INVALID', 'Task delegated capability is missing, expired, or no longer matches task scope', 409);
    }
  }

  private async assertApprovalSubjectAuthority(client: PoolClient, approval: ApprovalRow, task: TaskRow): Promise<void> {
    if (approval.business_task_id !== task.id || approval.requester_id !== task.requester_id) {
      throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approval no longer belongs to the current task authority', 409);
    }
    if (hashCanonical(approval.subject) !== approval.subject_digest
      || hashCanonical(this.subjectFromTask(task, task.id)) !== approval.subject_digest) {
      throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approved subject no longer matches task semantics', 409);
    }
    await this.assertDelegatedCapability(client, task);
    const inputRef = normalizeStoredInput(task.input_snapshot);
    if (inputRef.kind === 'document_snapshot') {
      await this.assertDocumentInputReady(client, { tenantId: task.tenant_id, userId: task.requester_id, trust: 'trusted-local' }, inputRef);
    }
    if (inputRef.kind === 'business_exception_snapshot') {
      await this.assertExceptionInputReady(
        client,
        { tenantId: task.tenant_id, userId: task.requester_id, trust: 'trusted-local' },
        task,
        inputRef,
      );
    }
  }

  private async assertApprovedExecutionAuthority(client: PoolClient, task: TaskRow, expected: ExecuteTaskInput): Promise<ApprovalRow> {
    const result = await client.query<ApprovalRow>('SELECT * FROM approval_versions WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE', [
      task.tenant_id,
      task.id,
    ]);
    const approval = result.rows[0];
    if (approval === undefined) throw new GenewayError('APPROVAL_REQUIRED', 'Task requires an approved immutable subject', 409);
    if (approval.version !== expected.expectedApprovalVersion
      || approval.subject_digest !== expected.expectedApprovalSubjectDigest) {
      throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Expected approval version or subject digest is stale', 409);
    }
    if (approval.status !== 'approved') throw new GenewayError('APPROVAL_REQUIRED', 'Task requires an approved immutable subject', 409);
    if (approval.expires_at.getTime() <= Date.now()) throw new GenewayError('APPROVAL_EXPIRED', 'Approved execution authority has expired', 409);
    await this.assertApprovalSubjectAuthority(client, approval, task);
    return approval;
  }

  private async appendEvent(client: PoolClient, tenantId: string, taskId: string, eventType: string, payload: unknown): Promise<string> {
    const taskUpdate = await client.query<{ aggregate_version: string }>('UPDATE business_tasks SET aggregate_version=aggregate_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING aggregate_version::text', [tenantId, taskId]);
    const aggregateVersion = Number(taskUpdate.rows[0]?.aggregate_version);
    if (!Number.isSafeInteger(aggregateVersion)) throw new GenewayError('TASK_NOT_FOUND', 'Cannot append event for missing task', 404);
    const sequenceResult = await client.query<{ sequence: string }>('SELECT coalesce(max(sequence),0)+1 AS sequence FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2', [tenantId, taskId]);
    const sequence = Number(sequenceResult.rows[0]?.sequence);
    const eventId = id('event');
    const eventPayload = { ...(typeof payload === 'object' && payload !== null ? payload : { value: payload }), ...SIMULATION_ENVELOPE };
    await client.query(`INSERT INTO business_task_events
      (tenant_id,id,business_task_id,sequence,event_type,aggregate_version,correlation_id,payload,simulation,runtime_mode,business_decision_allowed)
      VALUES ($1,$2,$3,$4,$5,$6,$3,$7,true,'fake',false)`, [tenantId, eventId, taskId, sequence, eventType, aggregateVersion, eventPayload]);
    await client.query('INSERT INTO outbox_events (tenant_id,id,business_task_id,event_id,event_type,payload) VALUES ($1,$2,$3,$4,$5,$6)', [tenantId, id('outbox'), taskId, eventId, eventType, eventPayload]);
    return eventId;
  }

  private async idempotent<T extends JsonObject>(
    client: PoolClient,
    principal: Principal,
    operation: string,
    key: string,
    request: unknown,
    effect: () => Promise<T>,
    onReplay?: (response: T) => Promise<void>,
  ): Promise<T> {
    if (key.length < 8 || key.length > 200) throw new GenewayError('IDEMPOTENCY_KEY_REQUIRED', 'A stable idempotency key of 8-200 characters is required', 400);
    const requestDigest = hashCanonical(request);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [principal.tenantId, `${principal.userId}:${operation}:${key}`]);
    const existing = await client.query<{ request_digest: string; response: T }>('SELECT request_digest,response FROM idempotency_records WHERE tenant_id=$1 AND principal_id=$2 AND operation=$3 AND idempotency_key=$4', [principal.tenantId, principal.userId, operation, key]);
    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.request_digest !== requestDigest) throw new GenewayError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different semantics', 409);
      await onReplay?.(row.response);
      return row.response;
    }
    const response = await effect();
    await client.query('INSERT INTO idempotency_records (tenant_id,principal_id,operation,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5,$6)', [principal.tenantId, principal.userId, operation, key, requestDigest, response]);
    return response;
  }

  private async withTransaction<T>(effect: (client: PoolClient) => Promise<T>): Promise<T> {
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
