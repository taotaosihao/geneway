import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { authorize, delegatedCapabilitySchema, type DelegatedCapability } from '@geneway/authorization';
import { GenewayError, SIMULATION_ENVELOPE, taskResultSchema, taskSnapshotSchema, type CreateTaskInput, type Principal, type TaskSnapshot } from '@geneway/contracts';
import { assertPublishableClaim, claimCandidateSchema, verifyEvidence, type ClaimCandidate, type EvidenceCandidate } from '@geneway/evidence';
import type { InterpreterControlPort, StepLease } from '@geneway/worker';
import {
  SOLUTION_CAPABILITY_VERSION_ID,
  SOLUTION_HARNESS_VERSION_ID,
  compileWorkflow,
  createSolutionAnalysisDraft,
  hashCanonical,
  readStoredWorkflowVersion,
  type CompiledWorkflowVersion,
} from '@geneway/workflow';

const { Pool } = pg;

type JsonObject = Readonly<Record<string, unknown>>;
type TaskRow = {
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
  expert_target: JsonObject;
  permission_scope: JsonObject;
  audience_scope: JsonObject;
  budget: JsonObject;
  simulation: boolean;
  runtime_mode: string;
  business_decision_allowed: boolean;
  aggregate_version: string;
  result: unknown;
};

type ApprovalRow = {
  id: string;
  version: number;
  subject: JsonObject;
  subject_digest: string;
  status: string;
  expires_at: Date;
};

export type CreatedTask = Readonly<{ taskId: string; approvalId: string; workflowVersionId: string; workflowHash: string }>;
export type ExecutionResponse = Readonly<{ taskId: string; status: 'completed' }>;

const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

export class ControlPlaneRepository implements InterpreterControlPort {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSystemSeed(): Promise<void> {
    await this.pool.query("INSERT INTO tenants (id, name) VALUES ('tenant_local', '本机演示租户') ON CONFLICT DO NOTHING");
    await this.pool.query("INSERT INTO users (tenant_id, id, display_name) VALUES ('tenant_local', 'user_local', '本机用户') ON CONFLICT DO NOTHING");
    await this.pool.query("INSERT INTO roles (tenant_id, user_id, role) VALUES ('tenant_local', 'user_local', 'solution_reviewer') ON CONFLICT DO NOTHING");
    await this.pool.query("INSERT INTO resource_scopes (tenant_id, user_id, resource_scope) VALUES ('tenant_local', 'user_local', 'fixture:solution-analysis:v1') ON CONFLICT DO NOTHING");
  }

  async resetForTest(): Promise<void> {
    await this.pool.query(`TRUNCATE TABLE
      idempotency_records, outbox_events, result_claims, minimal_evidence_refs, policy_decisions,
      delegated_capabilities, approval_versions, business_task_steps, business_task_events,
      business_tasks, workflow_versions, harness_versions, expert_catalog_versions,
      capability_versions, messages, conversations, resource_scopes, roles, users, tenants
      RESTART IDENTITY CASCADE`);
    await this.ensureSystemSeed();
  }

  async createConversation(principal: Principal, idempotencyKey: string): Promise<{ id: string }> {
    return this.withTransaction(async (client) => this.idempotent(client, principal.tenantId, 'conversation.create', idempotencyKey, {}, async () => {
      const conversationId = id('conversation');
      await client.query('INSERT INTO conversations (tenant_id, id, user_id) VALUES ($1, $2, $3)', [principal.tenantId, conversationId, principal.userId]);
      return { id: conversationId };
    }));
  }

  async addUserMessage(principal: Principal, conversationId: string, body: string, idempotencyKey: string): Promise<{ id: string }> {
    return this.withTransaction(async (client) => this.idempotent(client, principal.tenantId, 'conversation.message.create', idempotencyKey, { conversationId, body }, async () => {
      const conversation = await client.query('SELECT 1 FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [principal.tenantId, conversationId, principal.userId]);
      if (conversation.rowCount !== 1) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found in this tenant', 404);
      const messageId = id('message');
      await client.query("INSERT INTO messages (tenant_id,id,conversation_id,author,body) VALUES ($1,$2,$3,'user',$4)", [principal.tenantId, messageId, conversationId, body]);
      return { id: messageId };
    }));
  }

  async getConversation(principal: Principal, conversationId: string): Promise<JsonObject> {
    const conversation = await this.pool.query('SELECT id,created_at FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [principal.tenantId, conversationId, principal.userId]);
    const row = conversation.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found in this tenant', 404);
    const messages = await this.pool.query('SELECT id,author,body,created_at FROM messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at,id', [principal.tenantId, conversationId]);
    return { ...row, messages: messages.rows };
  }

  async createTask(principal: Principal, input: CreateTaskInput, idempotencyKey: string): Promise<CreatedTask> {
    const workflow = compileWorkflow(createSolutionAnalysisDraft());
    return this.withTransaction(async (client) => this.idempotent(client, principal.tenantId, 'business-task.create', idempotencyKey, input, async () => {
      const conversation = await client.query('SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2 AND user_id = $3', [principal.tenantId, input.conversationId, principal.userId]);
      if (conversation.rowCount !== 1) throw new GenewayError('CONVERSATION_NOT_FOUND', 'Conversation was not found in this tenant', 404);

      const versions = await this.ensureVersions(client, principal.tenantId, workflow);
      const resolvedExpert = this.resolveExpertTarget(input.expertTarget);
      const taskId = id('task');
      const approvalId = id('approval');
      const delegatedId = id('capability');
      const inputSnapshot = { fixtureRef: input.fixtureRef, fixtureVersion: 1, fixtureHash: hashCanonical({ fixtureRef: input.fixtureRef, version: 1 }) };
      const permissionScope = { actions: ['R0', 'R1', 'A1'], resourceScopes: [input.fixtureRef], dataClasses: ['C0', 'C1'] };
      const audienceScope = { kind: 'private-conversation', ids: [`conversation:${input.conversationId}`] };
      const budget = { maxRuntimeMs: 30_000, maxModelCost: 0, modelCallsAllowed: false };

      await client.query(`INSERT INTO business_tasks
        (tenant_id, id, conversation_id, capability_version_id, expert_catalog_version_id, harness_version_id,
         workflow_version_id, workflow_hash, requester_id, status, input_snapshot, expert_target,
         permission_scope, audience_scope, budget, simulation, runtime_mode, business_decision_allowed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12,$13,$14,true,'fake',false)`,
      [principal.tenantId, taskId, input.conversationId, SOLUTION_CAPABILITY_VERSION_ID, versions.expertCatalogVersionId,
        SOLUTION_HARNESS_VERSION_ID, workflow.id, workflow.hash, principal.userId, inputSnapshot,
        { requested: input.expertTarget, resolved: resolvedExpert }, permissionScope, audienceScope, budget]);

      for (const node of workflow.payload.nodes) {
        await client.query(`INSERT INTO business_task_steps
          (tenant_id, business_task_id, step_id, status, simulation, runtime_mode, business_decision_allowed)
          VALUES ($1,$2,$3,'queued',true,'fake',false)`, [principal.tenantId, taskId, node.id]);
      }

      const subject = this.buildApprovalSubject({
        taskId, requesterId: principal.userId, inputSnapshot, expertTarget: { requested: input.expertTarget, resolved: resolvedExpert },
        expertCatalogVersionId: versions.expertCatalogVersionId, harnessVersionId: SOLUTION_HARNESS_VERSION_ID,
        workflowVersionId: workflow.id, workflowHash: workflow.hash, permissionScope, audienceScope, budget,
      });
      const subjectDigest = hashCanonical(subject);
      await client.query(`INSERT INTO approval_versions
        (tenant_id,id,business_task_id,version,subject,subject_digest,status,requester_id,approver_policy_version,expires_at)
        VALUES ($1,$2,$3,1,$4,$5,'pending',$6,'trusted-local-readonly/1',now() + interval '15 minutes')`,
      [principal.tenantId, approvalId, taskId, subject, subjectDigest, principal.userId]);

      await client.query(`INSERT INTO delegated_capabilities
        (tenant_id,id,business_task_id,principal_id,allowed_actions,resource_scopes,audience_scope,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '15 minutes')`,
      [principal.tenantId, delegatedId, taskId, principal.userId, JSON.stringify(['R0', 'R1', 'A1']), JSON.stringify([input.fixtureRef]), JSON.stringify([`conversation:${input.conversationId}`])]);
      await client.query(`INSERT INTO policy_decisions (tenant_id,id,business_task_id,allow,reason_codes)
        VALUES ($1,$2,$3,true,$4)`, [principal.tenantId, id('policy'), taskId, JSON.stringify(['TRUSTED_LOCAL', 'FIXTURE_SCOPE_ALLOWED', 'ACTION_CEILING_A1'])]);
      await this.appendEvent(client, principal.tenantId, taskId, 'business_task.created', { approvalId, workflowVersionId: workflow.id, workflowHash: workflow.hash });
      return { taskId, approvalId, workflowVersionId: workflow.id, workflowHash: workflow.hash };
    }));
  }

  async getTask(principal: Principal, taskId: string): Promise<TaskSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const taskResult = await client.query<TaskRow>('SELECT * FROM business_tasks WHERE tenant_id = $1 AND id = $2', [principal.tenantId, taskId]);
      const task = taskResult.rows[0];
      if (task === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Task was not found in this tenant', 404);
      const approvalResult = await client.query<ApprovalRow>('SELECT * FROM approval_versions WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY version DESC LIMIT 1', [principal.tenantId, taskId]);
      const stepResult = await client.query<{ step_id: string; status: string; output: unknown }>('SELECT step_id,status,output FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY step_id', [principal.tenantId, taskId]);
      const claimResult = await client.query<{ id: string; text: string; status: 'published' | 'rejected'; evidence_ref_id: string | null; rejection_code: string | null }>('SELECT id,text,status,evidence_ref_id,rejection_code FROM result_claims WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY created_at,id', [principal.tenantId, taskId]);
      const evidenceResult = await client.query<{ id: string; source_id: string; source_excerpt: string; source_hash: string }>('SELECT id,source_id,source_excerpt,source_hash FROM minimal_evidence_refs WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY created_at,id', [principal.tenantId, taskId]);
      const watermarkResult = await client.query<{ watermark: string }>('SELECT coalesce(max(cursor),0)::text AS watermark FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2', [principal.tenantId, taskId]);
      const approval = approvalResult.rows[0];
      if (approval === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Task has no approval version', 500);
      const snapshot = taskSnapshotSchema.parse({
        id: task.id,
        conversationId: task.conversation_id,
        status: task.status,
        workflowVersion: { id: task.workflow_version_id, hash: task.workflow_hash },
        approval: { id: approval.id, version: approval.version, status: approval.status, subjectDigest: approval.subject_digest },
        expertTarget: (task.expert_target.requested ?? task.expert_target),
        steps: stepResult.rows.map((row) => ({ id: row.step_id, status: row.status, output: row.output })),
        claims: claimResult.rows.map((row) => ({ id: row.id, text: row.text, status: row.status, evidenceRefId: row.evidence_ref_id, rejectionCode: row.rejection_code })),
        evidence: evidenceResult.rows.map((row) => ({ id: row.id, sourceId: row.source_id, excerpt: row.source_excerpt, sourceHash: row.source_hash })),
        result: task.result,
        aggregateVersion: Number(task.aggregate_version),
        eventWatermark: Number(watermarkResult.rows[0]?.watermark ?? 0),
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

  async getEvents(principal: Principal, taskId: string, afterCursor: number): Promise<readonly JsonObject[]> {
    const visible = await this.pool.query('SELECT 1 FROM business_tasks WHERE tenant_id=$1 AND id=$2', [principal.tenantId, taskId]);
    if (visible.rowCount !== 1) throw new GenewayError('TASK_NOT_FOUND', 'Task was not found in this tenant', 404);
    const result = await this.pool.query(`SELECT cursor::text,id,business_task_id,sequence::text,event_type,payload,
      simulation,runtime_mode,business_decision_allowed,occurred_at
      FROM business_task_events WHERE tenant_id=$1 AND business_task_id=$2 AND cursor>$3 ORDER BY business_task_events.cursor`,
    [principal.tenantId, taskId, afterCursor]);
    return result.rows.map((row: Record<string, unknown>) => ({ ...row, cursor: Number(row.cursor), sequence: Number(row.sequence) }));
  }

  async decideApproval(principal: Principal, approvalId: string, decision: 'approved' | 'rejected', idempotencyKey: string): Promise<{ approvalId: string; status: string }> {
    return this.withTransaction(async (client) => this.idempotent(client, principal.tenantId, 'approval.decide', idempotencyKey, { approvalId, decision }, async () => {
      const result = await client.query<ApprovalRow & { business_task_id: string }>('SELECT * FROM approval_versions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [principal.tenantId, approvalId]);
      const approval = result.rows[0];
      if (approval === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Approval was not found in this tenant', 404);
      if (approval.status !== 'pending') {
        if (approval.status === decision) return { approvalId, status: decision };
        throw new GenewayError('APPROVAL_TERMINAL', 'Approval is already terminal', 409);
      }
      if (approval.expires_at.getTime() <= Date.now()) throw new GenewayError('APPROVAL_EXPIRED', 'Approval has expired', 409);
      const task = await this.requireTask(client, principal.tenantId, approval.business_task_id);
      const currentSubject = this.subjectFromTask(task, approval.business_task_id);
      if (hashCanonical(currentSubject) !== approval.subject_digest) throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Execution semantics changed; create a new approval version', 409);
      const updated = await client.query(`UPDATE approval_versions SET status=$3,decision_by=$4,decision_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [principal.tenantId, approvalId, decision, principal.userId]);
      if (updated.rowCount !== 1) throw new GenewayError('APPROVAL_CAS_CONFLICT', 'Approval decision lost a compare-and-set race', 409);
      await client.query('UPDATE business_tasks SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2', [principal.tenantId, approval.business_task_id, decision === 'approved' ? 'approved' : 'rejected']);
      await this.appendEvent(client, principal.tenantId, approval.business_task_id, 'approval.decided', { approvalId, decision });
      return { approvalId, status: decision };
    }));
  }

  async getApproval(principal: Principal, approvalId: string): Promise<JsonObject> {
    const result = await this.pool.query('SELECT id,business_task_id,version,subject,subject_digest,status,expires_at FROM approval_versions WHERE tenant_id=$1 AND id=$2', [principal.tenantId, approvalId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new GenewayError('APPROVAL_NOT_FOUND', 'Approval was not found in this tenant', 404);
    return row;
  }

  async getWorkflow(principal: Principal, workflowId: string): Promise<CompiledWorkflowVersion> {
    const result = await this.pool.query<{ id: string; workflow_hash: string; canonicalization_version: 'RFC8785/JCS-1'; canonical_json: unknown }>('SELECT * FROM workflow_versions WHERE tenant_id=$1 AND id=$2', [principal.tenantId, workflowId]);
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('WORKFLOW_NOT_FOUND', 'Workflow was not found in this tenant', 404);
    return readStoredWorkflowVersion({
      id: row.id,
      hash: row.workflow_hash,
      canonicalizationVersion: row.canonicalization_version,
      canonicalPayload: row.canonical_json,
    });
  }

  async executeIdempotently(principal: Principal, taskId: string, idempotencyKey: string, effect: () => Promise<ExecutionResponse>): Promise<ExecutionResponse> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new GenewayError('IDEMPOTENCY_KEY_REQUIRED', 'A stable idempotency key of 8-200 characters is required', 400);
    const operation = 'business-task.execute';
    const digest = hashCanonical({ taskId });
    const taskLockKey = `business-task.execute:${taskId}`;
    const idempotencyLockKey = `${operation}:${idempotencyKey}`;
    const client = await this.pool.connect();
    let taskLockHeld = false;
    let idempotencyLockHeld = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [principal.tenantId, taskLockKey]);
      taskLockHeld = true;
      await client.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [principal.tenantId, idempotencyLockKey]);
      idempotencyLockHeld = true;
      const existing = await client.query<{ request_digest: string; response: ExecutionResponse }>('SELECT request_digest,response FROM idempotency_records WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3', [principal.tenantId, operation, idempotencyKey]);
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.request_digest !== digest) throw new GenewayError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for different semantics', 409);
        return row.response;
      }
      const taskResult = await client.query<{ status: string }>('SELECT status FROM business_tasks WHERE tenant_id=$1 AND id=$2', [principal.tenantId, taskId]);
      const task = taskResult.rows[0];
      if (task === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Task was not found in this tenant', 404);
      if (task.status === 'completed') {
        const completed: ExecutionResponse = { taskId, status: 'completed' };
        await client.query('INSERT INTO idempotency_records (tenant_id,operation,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5)', [principal.tenantId, operation, idempotencyKey, digest, completed]);
        return completed;
      }
      if (task.status !== 'approved') throw new GenewayError('TASK_EXECUTION_NOT_READY', `Task cannot be executed from state ${task.status}`, 409);
      const response = await effect();
      await client.query('INSERT INTO idempotency_records (tenant_id,operation,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5)', [principal.tenantId, operation, idempotencyKey, digest, response]);
      return response;
    } finally {
      if (idempotencyLockHeld) await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [principal.tenantId, idempotencyLockKey]);
      if (taskLockHeld) await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [principal.tenantId, taskLockKey]);
      client.release();
    }
  }

  async startTask(tenantId: string, taskId: string, workflow: CompiledWorkflowVersion): Promise<void> {
    await this.withTransaction(async (client) => {
      const task = await this.requireTask(client, tenantId, taskId);
      if (task.workflow_version_id !== workflow.id || task.workflow_hash !== workflow.hash) throw new GenewayError('WORKFLOW_BINDING_MISMATCH', 'Interpreter received a different workflow version', 409);
      const approval = await client.query<ApprovalRow>('SELECT * FROM approval_versions WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE', [tenantId, taskId]);
      const row = approval.rows[0];
      if (row === undefined || row.status !== 'approved') throw new GenewayError('APPROVAL_REQUIRED', 'Task requires an approved immutable subject', 409);
      if (row.expires_at.getTime() <= Date.now()) throw new GenewayError('APPROVAL_EXPIRED', 'Approved execution authority has expired', 409);
      if (hashCanonical(this.subjectFromTask(task, taskId)) !== row.subject_digest) throw new GenewayError('APPROVAL_SUBJECT_CHANGED', 'Approved subject no longer matches task semantics', 409);
      const update = await client.query("UPDATE business_tasks SET status='running',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='approved'", [tenantId, taskId]);
      if (update.rowCount !== 1) throw new GenewayError('TASK_STATE_CONFLICT', 'Task is not ready to start', 409);
      await this.appendEvent(client, tenantId, taskId, 'workflow.run_started', { workflowVersionId: workflow.id, workflowHash: workflow.hash });
    });
  }

  async claimStep(tenantId: string, taskId: string, stepId: string, attemptId: string): Promise<StepLease> {
    return this.withTransaction(async (client) => {
      const fixedOrder = ['document_ingest', 'requirement_extract', 'contradiction_check', 'solution_design', 'evidence_verify', 'result_quality_check', 'report_publish'];
      const stepIndex = fixedOrder.indexOf(stepId);
      if (stepIndex < 0) throw new GenewayError('NOT_OPEN', `Step is not open in Gate 0.1: ${stepId}`, 422);
      const predecessor = fixedOrder[stepIndex - 1];
      if (predecessor !== undefined) {
        const predecessorResult = await client.query("SELECT 1 FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='completed'", [tenantId, taskId, predecessor]);
        if (predecessorResult.rowCount !== 1) throw new GenewayError('STEP_DEPENDENCY_NOT_READY', `Predecessor ${predecessor} is not complete`, 409);
      }
      const result = await client.query<{ fencing_token: string }>(`UPDATE business_task_steps SET status='running',attempt_id=$4,
        fencing_token=fencing_token+1,lease_until=now()+interval '1 minute',updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='queued'
        RETURNING fencing_token::text`, [tenantId, taskId, stepId, attemptId]);
      const row = result.rows[0];
      if (row === undefined) throw new GenewayError('STEP_CLAIM_CONFLICT', `Step ${stepId} cannot be claimed`, 409);
      await this.appendEvent(client, tenantId, taskId, 'workflow.step_started', { stepId, attemptId, fencingToken: Number(row.fencing_token) });
      return { attemptId, fencingToken: Number(row.fencing_token) };
    });
  }

  async completeStep(tenantId: string, taskId: string, stepId: string, lease: StepLease, output: unknown): Promise<void> {
    await this.withTransaction(async (client) => {
      const result = await client.query(`UPDATE business_task_steps SET status='completed',output=$6,updated_at=now()
        WHERE tenant_id=$1 AND business_task_id=$2 AND step_id=$3 AND status='running'
          AND attempt_id=$4 AND fencing_token=$5 AND lease_until>now()`,
      [tenantId, taskId, stepId, lease.attemptId, lease.fencingToken, output]);
      if (result.rowCount !== 1) throw new GenewayError('STALE_STEP_COMPLETION', `Stale completion rejected for ${stepId}`, 409);
      await this.appendEvent(client, tenantId, taskId, 'workflow.step_completed', { stepId, attemptId: lease.attemptId, fencingToken: lease.fencingToken });
    });
  }

  async publishEvidenceAndClaims(tenantId: string, taskId: string, evidence: EvidenceCandidate | undefined, claims: readonly ClaimCandidate[]): Promise<void> {
    await this.withTransaction(async (client) => {
      const task = await this.requireTask(client, tenantId, taskId);
      const capabilityResult = await client.query('SELECT * FROM delegated_capabilities WHERE tenant_id=$1 AND business_task_id=$2 ORDER BY expires_at DESC LIMIT 1', [tenantId, taskId]);
      const rawCapability = capabilityResult.rows[0] as Record<string, unknown> | undefined;
      if (rawCapability === undefined) throw new GenewayError('CAPABILITY_NOT_FOUND', 'No delegated capability is bound to the task', 403);
      const capability: DelegatedCapability = delegatedCapabilitySchema.parse({
        id: rawCapability.id, tenantId: rawCapability.tenant_id, businessTaskId: rawCapability.business_task_id,
        principalId: rawCapability.principal_id, allowedActions: rawCapability.allowed_actions,
        resourceScopes: rawCapability.resource_scopes, audienceScope: rawCapability.audience_scope, expiresAt: rawCapability.expires_at,
      });
      authorize({
        principal: { tenantId, userId: task.requester_id, trust: 'trusted-local' }, capability,
        businessTaskId: taskId, action: 'R1', resourceScope: 'fixture:solution-analysis:v1', audience: `conversation:${task.conversation_id}`,
      });

      if (evidence !== undefined) {
        verifyEvidence(evidence, tenantId, taskId, new Set(capability.resourceScopes));
        await client.query(`INSERT INTO minimal_evidence_refs
          (tenant_id,id,business_task_id,source_id,source_excerpt,source_hash,resource_scope,data_class,accessible,
           simulation,runtime_mode,business_decision_allowed)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'fake',false)`,
        [tenantId, evidence.id, taskId, evidence.sourceId, evidence.sourceExcerpt, evidence.sourceHash, evidence.resourceScope, evidence.dataClass, evidence.accessible]);
      }

      for (const claim of claims) {
        claimCandidateSchema.parse(claim);
        if (claim.evidenceRefId === null) {
          await client.query(`INSERT INTO result_claims
            (tenant_id,id,business_task_id,text,status,evidence_ref_id,rejection_code,simulation,runtime_mode,business_decision_allowed)
            VALUES ($1,$2,$3,$4,'rejected',null,'CLAIM_EVIDENCE_REQUIRED',true,'fake',false)`, [tenantId, claim.id, taskId, claim.text]);
        } else {
          const validEvidence = assertPublishableClaim(claim, evidence);
          await client.query(`INSERT INTO result_claims
            (tenant_id,id,business_task_id,text,status,evidence_ref_id,rejection_code,simulation,runtime_mode,business_decision_allowed)
            VALUES ($1,$2,$3,$4,'published',$5,null,true,'fake',false)`, [tenantId, claim.id, taskId, claim.text, validEvidence.id]);
        }
      }
      await this.appendEvent(client, tenantId, taskId, 'claim.created', { published: claims.filter((claim) => claim.evidenceRefId !== null).length, rejected: claims.filter((claim) => claim.evidenceRefId === null).length });
    });
  }

  async completeTask(tenantId: string, taskId: string, result: unknown): Promise<void> {
    const parsedResult = taskResultSchema.parse(result);
    if (parsedResult.kind !== 'completed') throw new GenewayError('INVALID_COMPLETION_RESULT', 'Task completion requires a completed result envelope', 422);
    await this.withTransaction(async (client) => {
      const incomplete = await client.query("SELECT 1 FROM business_task_steps WHERE tenant_id=$1 AND business_task_id=$2 AND status<>'completed' LIMIT 1", [tenantId, taskId]);
      const published = await client.query("SELECT 1 FROM result_claims WHERE tenant_id=$1 AND business_task_id=$2 AND status='published' LIMIT 1", [tenantId, taskId]);
      if (incomplete.rowCount !== 0 || published.rowCount !== 1) throw new GenewayError('RESULT_PUBLISH_GUARD', 'Task cannot complete without all steps and at least one evidenced claim', 409);
      const update = await client.query("UPDATE business_tasks SET status='completed',result=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='running'", [tenantId, taskId, parsedResult]);
      if (update.rowCount !== 1) throw new GenewayError('TASK_STATE_CONFLICT', 'Task cannot complete from its current state', 409);
      const task = await this.requireTask(client, tenantId, taskId);
      await client.query("INSERT INTO messages (tenant_id,id,conversation_id,author,body) VALUES ($1,$2,$3,'xiaowei',$4)", [tenantId, id('message'), task.conversation_id, '小纬已完成模拟方案分析。结果仅供演示，不能用于业务决策。']);
      await this.appendEvent(client, tenantId, taskId, 'business_task.completed', { result: parsedResult });
    });
  }

  async failTask(tenantId: string, taskId: string, code: string, message: string): Promise<void> {
    const failedResult = taskResultSchema.parse({ kind: 'failed', code, message, ...SIMULATION_ENVELOPE });
    await this.withTransaction(async (client) => {
      const update = await client.query("UPDATE business_tasks SET status='failed',result=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status NOT IN ('completed','failed','rejected')", [tenantId, taskId, failedResult]);
      if (update.rowCount === 1) await this.appendEvent(client, tenantId, taskId, 'business_task.failed', { code, message });
    });
  }

  async getClaim(principal: Principal, claimId: string): Promise<JsonObject> {
    const result = await this.pool.query('SELECT * FROM result_claims WHERE tenant_id=$1 AND id=$2', [principal.tenantId, claimId]);
    const row = result.rows[0] as JsonObject | undefined;
    if (row === undefined) throw new GenewayError('CLAIM_NOT_FOUND', 'Claim was not found in this tenant', 404);
    return row;
  }

  async getEvidence(principal: Principal, evidenceId: string): Promise<JsonObject> {
    const result = await this.pool.query('SELECT * FROM minimal_evidence_refs WHERE tenant_id=$1 AND id=$2 AND accessible=true', [principal.tenantId, evidenceId]);
    const row = result.rows[0] as JsonObject | undefined;
    if (row === undefined) throw new GenewayError('EVIDENCE_NOT_FOUND', 'Evidence was not found or is inaccessible in this tenant', 404);
    return row;
  }

  private async ensureVersions(client: PoolClient, tenantId: string, workflow: CompiledWorkflowVersion): Promise<{ expertCatalogVersionId: string }> {
    const expertCatalogVersionId = 'expert_catalog_solution_v1_1';
    await client.query(`INSERT INTO capability_versions (tenant_id,id,capability_id,version,spec)
      VALUES ($1,$2,'solution.analysis.v1',1,$3) ON CONFLICT DO NOTHING`, [tenantId, SOLUTION_CAPABILITY_VERSION_ID, { allowedExpertIds: ['expert.solution.architect'], allowedTeamIds: ['team.solution.core'], actionCeiling: 'A1' }]);
    await client.query(`INSERT INTO expert_catalog_versions (tenant_id,id,version,catalog)
      VALUES ($1,$2,1,$3) ON CONFLICT DO NOTHING`, [tenantId, expertCatalogVersionId, {
      experts: [{ id: 'expert.solution.architect', name: '方案专家', healthy: true }],
      teams: [{ id: 'team.solution.core', name: '方案专家团', expertIds: ['expert.solution.architect'], healthy: true }],
    }]);
    await client.query(`INSERT INTO harness_versions (tenant_id,id,capability_version_id,version,spec)
      VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING`, [tenantId, SOLUTION_HARNESS_VERSION_ID, SOLUTION_CAPABILITY_VERSION_ID, { runtime: 'fake', verifier: 'claim-evidence-minimum/1', maxSteps: 7 }]);
    await client.query(`INSERT INTO workflow_versions (tenant_id,id,workflow_hash,canonicalization_version,canonical_json)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tenantId, workflow.id, workflow.hash, workflow.canonicalizationVersion, JSON.parse(workflow.canonicalJson) as unknown]);
    return { expertCatalogVersionId };
  }

  private resolveExpertTarget(target: CreateTaskInput['expertTarget']): JsonObject {
    if (target.mode === 'auto') return { mode: 'expert', expertId: 'expert.solution.architect', resolution: 'automatic' };
    if (target.mode === 'expert' && target.expertId === 'expert.solution.architect') return { ...target, resolution: 'explicit' };
    if (target.mode === 'team' && target.teamId === 'team.solution.core') return { ...target, resolution: 'explicit' };
    throw new GenewayError('EXPERT_NOT_ALLOWED', 'Expert or expert team is missing, unhealthy, or outside the capability allowlist', 422);
  }

  private buildApprovalSubject(input: Readonly<{
    taskId: string; requesterId: string; inputSnapshot: JsonObject; expertTarget: JsonObject;
    expertCatalogVersionId: string; harnessVersionId: string; workflowVersionId: string; workflowHash: string;
    permissionScope: JsonObject; audienceScope: JsonObject; budget: JsonObject;
  }>): JsonObject {
    return {
      kind: 'workflow-execution', subjectType: 'business-task', subjectId: input.taskId, subjectVersion: 1,
      requesterId: input.requesterId, inputSnapshot: input.inputSnapshot, resolvedExpertTarget: input.expertTarget,
      expertCatalogVersionId: input.expertCatalogVersionId, harnessVersionId: input.harnessVersionId,
      workflowVersionId: input.workflowVersionId, workflowHash: input.workflowHash,
      permissionScope: input.permissionScope, audienceScope: input.audienceScope, budget: input.budget,
      simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false,
    };
  }

  private subjectFromTask(task: TaskRow, taskId: string): JsonObject {
    return this.buildApprovalSubject({
      taskId, requesterId: task.requester_id, inputSnapshot: task.input_snapshot,
      expertTarget: task.expert_target, expertCatalogVersionId: task.expert_catalog_version_id,
      harnessVersionId: task.harness_version_id, workflowVersionId: task.workflow_version_id,
      workflowHash: task.workflow_hash, permissionScope: task.permission_scope,
      audienceScope: task.audience_scope, budget: task.budget,
    });
  }

  private async requireTask(client: PoolClient, tenantId: string, taskId: string): Promise<TaskRow> {
    const result = await client.query<TaskRow>('SELECT * FROM business_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, taskId]);
    const task = result.rows[0];
    if (task === undefined) throw new GenewayError('TASK_NOT_FOUND', 'Task was not found in this tenant', 404);
    return task;
  }

  private async appendEvent(client: PoolClient, tenantId: string, taskId: string, eventType: string, payload: unknown): Promise<void> {
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
    await client.query(`INSERT INTO outbox_events (tenant_id,id,business_task_id,event_id,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, id('outbox'), taskId, eventId, eventType, eventPayload]);
  }

  private async idempotent<T extends JsonObject>(client: PoolClient, tenantId: string, operation: string, key: string, request: unknown, effect: () => Promise<T>): Promise<T> {
    if (key.length < 8 || key.length > 200) throw new GenewayError('IDEMPOTENCY_KEY_REQUIRED', 'A stable idempotency key of 8-200 characters is required', 400);
    const digest = hashCanonical(request);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, `${operation}:${key}`]);
    const existing = await client.query<{ request_digest: string; response: T }>('SELECT request_digest,response FROM idempotency_records WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3', [tenantId, operation, key]);
    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.request_digest !== digest) throw new GenewayError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for different semantics', 409);
      return row.response;
    }
    const response = await effect();
    await client.query('INSERT INTO idempotency_records (tenant_id,operation,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4,$5)', [tenantId, operation, key, digest, response]);
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
