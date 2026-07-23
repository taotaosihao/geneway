import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import {
  businessExceptionDetailSchema,
  businessExceptionListItemSchema,
  businessExceptionListResponseSchema,
  createExceptionAnalysisTaskResponseSchema,
  GenewayError,
  resolvedTaskInputRefSchema,
  type BusinessExceptionDetail,
  type BusinessExceptionListItem,
  type BusinessExceptionListQuery,
  type BusinessExceptionListResponse,
  type CreateExceptionAnalysisTaskInput,
  type CreateExceptionAnalysisTaskResponse,
  type Principal,
} from '@geneway/contracts';
import {
  EXCEPTION_ASSIST_CAPABILITY_VERSION_ID,
  EXCEPTION_ASSIST_HARNESS_VERSION_ID,
  EXCEPTION_ASSIST_ROUTING_POLICY_VERSION,
  compileWorkflow,
  createExceptionAssistDraft,
  hashCanonical,
} from '@geneway/workflow';
import { buildApprovalSubject } from './repository.js';

const { Pool } = pg;
const id = (prefix: string): string => `${prefix}_${randomUUID()}`;
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

const QUERY_VERSION = 'business-exceptions.list.v1';
const FIELD_MASK_VERSION = 'business-exceptions.list.public.v1';
const QUERY_SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
const EXPERT_CATALOG_VERSION_ID = 'expert_catalog_exception_assist_v1_1';

type JsonObject = Readonly<Record<string, unknown>>;

type ExceptionRow = Readonly<{
  tenant_id: string;
  id: string;
  source_version_id: string;
  source_system: 'fixture-manufacturing';
  exception_type: 'capacity_progress_lag' | 'equipment_alarm';
  source_object_ref: string;
  detection_window: string;
  fixture_version: 'gate0.2b-capacity-lag/1' | 'gate0.2b-equipment-alarm/1';
  fixture_sha256: string;
  canonicalization_version: 'rfc8785-jcs/1';
  resource_scope: string;
  data_class: 'C1';
  summary: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  detected_at: Date;
  status: 'open' | 'acknowledged';
  owner_principal_id: string | null;
  acknowledged_at: Date | null;
  aggregate_version: string;
  simulation: true;
  created_at: Date;
  updated_at: Date;
}>;

type SourceSnapshotRow = Readonly<{
  source_version_id: string;
  business_exception_id: string;
  canonical_bytes: Buffer;
  canonical_sha256: string;
  canonicalization_version: 'rfc8785-jcs/1';
  fixture_version: 'gate0.2b-capacity-lag/1' | 'gate0.2b-equipment-alarm/1';
  source_system: 'fixture-manufacturing';
  source_object_ref: string;
  detection_window: string;
  resource_scope: string;
  data_class: 'C1';
  audience: JsonObject;
}>;

type QuerySnapshotRow = Readonly<{
  id: string;
  query_kind: 'business_exceptions';
  authorization_epoch: string;
  canonical_query: JsonObject;
  query_version: string;
  field_mask_version: string;
  as_of: Date;
  expires_at: Date;
}>;

type CursorPayload = Readonly<{ snapshotId: string; position: number; expiresAt: number }>;

export type BusinessExceptionFixture = Readonly<{
  canonicalBytes: string;
  expectedSha256: string;
}>;

export const GATE_0_2B_EXCEPTION_FIXTURES = Object.freeze([
  {
    canonicalBytes: '{"dataClass":"C1","detectedAt":"2026-07-21T08:30:00.000Z","detectionWindow":"2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z","exceptionType":"capacity_progress_lag","fixtureVersion":"gate0.2b-capacity-lag/1","resourceScope":"factory-01/workshop-machining/line-02","severity":"high","sourceObjectRef":"work-order:WO-GATE02B-001","sourceSystem":"fixture-manufacturing","summary":"二号机加工线工单进度落后","values":{"completedQty":48,"elapsedPct":75,"planQty":100,"progressPct":48,"thresholdPct":60}}',
    expectedSha256: '0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6',
  },
  {
    canonicalBytes: '{"dataClass":"C1","detectedAt":"2026-07-21T08:35:00.000Z","detectionWindow":"2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z","exceptionType":"equipment_alarm","fixtureVersion":"gate0.2b-equipment-alarm/1","resourceScope":"factory-01/workshop-machining/line-02/equipment-CNC-017","severity":"medium","sourceObjectRef":"equipment:CNC-017","sourceSystem":"fixture-manufacturing","summary":"CNC-017 主轴温度报警","values":{"alarmCode":"SPINDLE_TEMP_HIGH","currentValue":78.2,"threshold":75,"unit":"°C"}}',
    expectedSha256: 'c8de7202aa3d5a395bbc96df13776fbdc68591687d6e0fbd144d1c9a1e5ea593',
  },
] satisfies readonly BusinessExceptionFixture[]);

function parseFixture(fixture: BusinessExceptionFixture): Readonly<{
  dataClass: 'C1';
  detectedAt: string;
  detectionWindow: string;
  exceptionType: 'capacity_progress_lag' | 'equipment_alarm';
  fixtureVersion: 'gate0.2b-capacity-lag/1' | 'gate0.2b-equipment-alarm/1';
  resourceScope: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  sourceObjectRef: string;
  sourceSystem: 'fixture-manufacturing';
  summary: string;
  values: Readonly<Record<string, string | number | boolean | null>>;
}> {
  if (sha256(fixture.canonicalBytes) !== fixture.expectedSha256) {
    throw new GenewayError('FIXTURE_HASH_MISMATCH', 'BusinessException fixture bytes do not match the fixed contract', 409);
  }
  const raw = JSON.parse(fixture.canonicalBytes) as Record<string, unknown>;
  if (raw.sourceSystem !== 'fixture-manufacturing' || raw.dataClass !== 'C1'
    || (raw.exceptionType !== 'capacity_progress_lag' && raw.exceptionType !== 'equipment_alarm')
    || (raw.fixtureVersion !== 'gate0.2b-capacity-lag/1' && raw.fixtureVersion !== 'gate0.2b-equipment-alarm/1')
    || typeof raw.detectedAt !== 'string' || typeof raw.detectionWindow !== 'string'
    || typeof raw.resourceScope !== 'string' || typeof raw.sourceObjectRef !== 'string'
    || typeof raw.summary !== 'string' || typeof raw.values !== 'object' || raw.values === null
    || !['critical', 'high', 'medium', 'low'].includes(String(raw.severity))) {
    throw new GenewayError('FIXTURE_CONTRACT_INVALID', 'BusinessException fixture is outside the fixed contract', 409);
  }
  return raw as ReturnType<typeof parseFixture>;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export class BusinessExceptionRepository {
  readonly pool: pg.Pool;

  constructor(connectionOrPool: string | pg.Pool, private readonly cursorHmacSecret: string) {
    if (cursorHmacSecret.length < 32) throw new Error('GENEWAY_CURSOR_HMAC_SECRET must contain at least 32 characters');
    this.pool = typeof connectionOrPool === 'string' ? new Pool({ connectionString: connectionOrPool, max: 10 }) : connectionOrPool;
  }

  async seedFixedFixtures(input: Readonly<{
    nodeEnvironment: string | undefined;
    controlPlaneHost: string;
    tenantId: string;
    fixtures?: readonly BusinessExceptionFixture[];
  }>): Promise<readonly Readonly<{ id: string; sourceVersionId: string; created: boolean }>[] > {
    const fixtures = input.fixtures ?? GATE_0_2B_EXCEPTION_FIXTURES;
    if ((input.nodeEnvironment !== 'test' && input.nodeEnvironment !== 'development')
      || !isLoopback(input.controlPlaneHost) || input.tenantId !== 'tenant_local') {
      throw new GenewayError('FIXTURE_SEED_NOT_ALLOWED', 'BusinessException fixture seed is limited to the local non-production tenant', 403);
    }
    const frozenIdentities = new Set(GATE_0_2B_EXCEPTION_FIXTURES.map((fixture) =>
      `${fixture.expectedSha256}\0${fixture.canonicalBytes}`));
    if (fixtures.length !== GATE_0_2B_EXCEPTION_FIXTURES.length
      || fixtures.some((fixture) => !frozenIdentities.has(`${fixture.expectedSha256}\0${fixture.canonicalBytes}`))) {
      throw new GenewayError('FIXTURE_SET_INVALID', 'BusinessException fixture bytes and hashes must exactly match the frozen contract', 409);
    }
    const parsed = fixtures.map((fixture) => ({ fixture, value: parseFixture(fixture) }));
    if (parsed.length !== 2
      || new Set(parsed.map(({ value }) => value.fixtureVersion)).size !== 2
      || new Set(parsed.map(({ fixture }) => fixture.expectedSha256)).size !== 2) {
      throw new GenewayError('FIXTURE_SET_INVALID', 'BusinessException fixture set must contain the two fixed versions', 409);
    }

    return this.withTransaction(async (client) => {
      const database = await client.query<{ is_non_production: boolean }>(
        'SELECT is_non_production FROM control_plane_database_metadata WHERE singleton=true FOR SHARE',
      );
      if (database.rows[0]?.is_non_production !== true) {
        throw new GenewayError('FIXTURE_DATABASE_NOT_ALLOWED', 'Target database is not marked non-production', 403);
      }
      const tenant = await client.query('SELECT 1 FROM tenants WHERE id=$1', [input.tenantId]);
      if (tenant.rowCount !== 1) throw new GenewayError('FIXTURE_TENANT_NOT_ALLOWED', 'Fixture tenant does not exist', 403);

      const results: Array<{ id: string; sourceVersionId: string; created: boolean }> = [];
      for (const { fixture, value } of parsed) {
        const exceptionId = id('exception');
        const sourceVersionId = `exception_source_${fixture.expectedSha256.slice(0, 32)}`;
        const inserted = await client.query<{ id: string; source_version_id: string }>(`INSERT INTO business_exceptions
          (tenant_id,id,source_version_id,source_system,exception_type,source_object_ref,detection_window,
           fixture_version,fixture_sha256,canonicalization_version,resource_scope,data_class,summary,severity,detected_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rfc8785-jcs/1',$10,$11,$12,$13,$14)
          ON CONFLICT (tenant_id,source_system,exception_type,source_object_ref,detection_window) DO NOTHING
          RETURNING id,source_version_id`, [
          input.tenantId, exceptionId, sourceVersionId, value.sourceSystem, value.exceptionType,
          value.sourceObjectRef, value.detectionWindow, value.fixtureVersion, fixture.expectedSha256,
          value.resourceScope, value.dataClass, value.summary, value.severity, value.detectedAt,
        ]);
        const created = inserted.rowCount === 1;
        const selected = created ? inserted : await client.query<{ id: string; source_version_id: string }>(`SELECT id,source_version_id
          FROM business_exceptions WHERE tenant_id=$1 AND source_system=$2 AND exception_type=$3
            AND source_object_ref=$4 AND detection_window=$5 FOR SHARE`, [
          input.tenantId, value.sourceSystem, value.exceptionType, value.sourceObjectRef, value.detectionWindow,
        ]);
        const authority = selected.rows[0];
        if (authority === undefined) throw new GenewayError('FIXTURE_SEED_FAILED', 'Fixture authority could not be established', 500);
        if (!created) {
          const existing = await client.query<{ fixture_sha256: string; fixture_version: string; source_version_id: string }>(
            'SELECT fixture_sha256,fixture_version,source_version_id FROM business_exceptions WHERE tenant_id=$1 AND id=$2',
            [input.tenantId, authority.id],
          );
          const row = existing.rows[0];
          if (row?.fixture_sha256 !== fixture.expectedSha256 || row.fixture_version !== value.fixtureVersion
            || row.source_version_id !== sourceVersionId) {
            throw new GenewayError('FIXTURE_AUTHORITY_CONFLICT', 'Existing exception does not match the immutable fixture authority', 409);
          }
          results.push({ id: authority.id, sourceVersionId: authority.source_version_id, created: false });
          continue;
        }

        const audience = {
          kind: 'resource_exception', businessExceptionId: authority.id,
          resourceScope: value.resourceScope, dataClass: value.dataClass,
        };
        await client.query(`INSERT INTO business_exception_source_snapshots
          (tenant_id,source_version_id,business_exception_id,canonical_bytes,canonical_sha256,
           canonicalization_version,fixture_version,source_system,source_object_ref,detection_window,
           resource_scope,data_class,audience)
          VALUES ($1,$2,$3,$4,$5,'rfc8785-jcs/1',$6,$7,$8,$9,$10,$11,$12)`, [
          input.tenantId, authority.source_version_id, authority.id, Buffer.from(fixture.canonicalBytes, 'utf8'),
          fixture.expectedSha256, value.fixtureVersion, value.sourceSystem, value.sourceObjectRef,
          value.detectionWindow, value.resourceScope, value.dataClass, audience,
        ]);
        const eventId = id('exception_event');
        const eventPayload = { sourceVersionId: authority.source_version_id, sourceSha256: fixture.expectedSha256, simulation: true };
        await client.query(`INSERT INTO business_exception_events
          (tenant_id,id,business_exception_id,sequence,event_type,aggregate_version,correlation_id,payload)
          VALUES ($1,$2,$3,1,'business_exception.detected',1,$2,$4)`, [input.tenantId, eventId, authority.id, eventPayload]);
        await client.query(`INSERT INTO audit_events
          (tenant_id,id,principal_id,event_type,resource_type,resource_id,outcome,reason_code,details)
          VALUES ($1,$2,'system_gate0.2b_seed','business_exception.seeded','business_exception',$3,'allowed','FIXED_FIXTURE_VERIFIED',$4)`, [
          input.tenantId, id('audit'), authority.id, { sourceVersionId: authority.source_version_id, fixtureSha256: fixture.expectedSha256 },
        ]);
        await client.query(`INSERT INTO outbox_events
          (tenant_id,id,business_task_id,business_exception_id,event_id,event_type,payload)
          VALUES ($1,$2,NULL,$3,$4,'business_exception.detected',$5)`, [
          input.tenantId, id('outbox'), authority.id, eventId, eventPayload,
        ]);
        results.push({ id: authority.id, sourceVersionId: authority.source_version_id, created: true });
      }
      return results;
    });
  }

  async list(principal: Principal, query: BusinessExceptionListQuery): Promise<BusinessExceptionListResponse> {
    return this.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      if (query.cursor === undefined) {
        const listCapability = await client.query(`SELECT 1 FROM users principal_user
          WHERE principal_user.tenant_id=$1 AND principal_user.id=$2
            AND EXISTS (SELECT 1 FROM roles role_binding
              WHERE role_binding.tenant_id=principal_user.tenant_id AND role_binding.user_id=principal_user.id
                AND role_binding.role='solution_reviewer')`, [principal.tenantId, principal.userId]);
        if (listCapability.rowCount !== 1) {
          throw new GenewayError('BUSINESS_EXCEPTION_LIST_FORBIDDEN', 'Business exception list permission is required', 403);
        }
      }
      const canonicalQuery = {
        status: query.status ?? null,
        severity: query.severity ?? null,
        exceptionType: query.exceptionType ?? null,
        resourceScope: query.resourceScope ?? null,
        sort: query.sort,
        direction: query.direction,
        limit: query.limit,
      };
      const authorizationEpoch = await this.authorizationEpoch(client, principal);
      let snapshot: QuerySnapshotRow;
      let position = 0;
      if (query.cursor === undefined) {
        if (query.resourceScope !== undefined && !await this.scopeIsAuthorized(client, principal, query.resourceScope)) {
          throw new GenewayError('RESOURCE_SCOPE_NOT_ALLOWED', 'Requested resource scope is not authorized', 403);
        }
        const order = query.sort === 'severity'
          ? "CASE e.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,e.id ASC"
          : 'e.detected_at DESC,e.id ASC';
        const candidates = await client.query<ExceptionRow>(`SELECT e.* FROM business_exceptions e
          WHERE e.tenant_id=$1 AND ($2::text IS NULL OR e.status=$2)
            AND ($3::text IS NULL OR e.severity=$3) AND ($4::text IS NULL OR e.exception_type=$4)
            AND ($5::text IS NULL OR e.resource_scope=$5 OR e.resource_scope LIKE $5 || '/%')
            AND ${this.readAuthorizationSql('e')}
          ORDER BY ${order}`, [
          principal.tenantId, query.status ?? null, query.severity ?? null,
          query.exceptionType ?? null, query.resourceScope ?? null, principal.userId,
        ]);
        snapshot = await this.createQuerySnapshot(client, principal, authorizationEpoch, canonicalQuery,
          candidates.rows.map((row) => ({
            objectId: row.id,
            sortKey: query.sort === 'severity'
              ? { severity: row.severity, id: row.id }
              : { detectedAt: row.detected_at.toISOString(), id: row.id },
          })));
      } else {
        const cursor = this.parseCursor(query.cursor);
        position = cursor.position;
        snapshot = await this.requireQuerySnapshot(client, principal, cursor, authorizationEpoch, canonicalQuery);
      }
      const page = await this.readPage(client, principal, snapshot, position, query.limit);
      return businessExceptionListResponseSchema.parse({
        exceptions: page.items,
        nextCursor: page.nextCursor,
        asOf: snapshot.as_of.toISOString(),
        queryVersion: snapshot.query_version,
      });
    });
  }

  async get(principal: Principal, exceptionId: string): Promise<BusinessExceptionDetail> {
    return this.withTransaction((client) => this.getWithClient(client, principal, exceptionId));
  }

  async acknowledge(principal: Principal, exceptionId: string, aggregateVersion: number): Promise<BusinessExceptionDetail> {
    return this.withTransaction(async (client) => {
      const exception = await this.requireReadable(client, principal, exceptionId, true);
      if (exception.status === 'acknowledged') {
        if (exception.owner_principal_id !== principal.userId) {
          throw new GenewayError('BUSINESS_EXCEPTION_CONFLICT', 'Business exception state changed', 409);
        }
        return this.projectDetail(client, principal, exception);
      }
      const updated = await client.query<ExceptionRow>(`UPDATE business_exceptions
        SET status='acknowledged',owner_principal_id=$3,acknowledged_at=now(),
            aggregate_version=aggregate_version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND status='open' AND aggregate_version=$4
        RETURNING *`, [principal.tenantId, exceptionId, principal.userId, aggregateVersion]);
      const row = updated.rows[0];
      if (row === undefined) throw new GenewayError('BUSINESS_EXCEPTION_STALE', 'Business exception snapshot is stale', 409);
      await this.appendExceptionMutation(client, principal, row, 'business_exception.acknowledged', {
        acknowledgedAt: row.acknowledged_at?.toISOString(),
      });
      return this.projectDetail(client, principal, row);
    });
  }

  async createAnalysisTask(
    principal: Principal,
    exceptionId: string,
    input: CreateExceptionAnalysisTaskInput,
  ): Promise<CreateExceptionAnalysisTaskResponse> {
    return this.withTransaction(async (client) => {
      const exception = await this.requireReadable(client, principal, exceptionId, true);
      if (exception.status !== 'acknowledged' || exception.owner_principal_id !== principal.userId) {
        throw new GenewayError('BUSINESS_EXCEPTION_NOT_OWNED', 'Business exception is not acknowledged by the current principal', 409);
      }
      const snapshot = await this.requireSourceSnapshot(client, principal, exception);
      const permissionCeiling = { actions: ['R0', 'R1', 'A1'], resourceScopes: [exception.resource_scope], dataClasses: ['C1'] };
      const resolvedExpertTarget = this.resolveExpertTarget(input.requestedExpertTarget);
      const inputDigest = hashCanonical({
        sourceVersionId: exception.source_version_id,
        sourceSha256: snapshot.canonical_sha256,
        capabilityVersionId: EXCEPTION_ASSIST_CAPABILITY_VERSION_ID,
        requesterPrincipalId: principal.userId,
        requestedExpertTarget: input.requestedExpertTarget,
        resolvedExpertTarget,
        expertCatalogVersion: EXPERT_CATALOG_VERSION_ID,
        permissionCeiling,
      });

      const existing = await client.query<{
        business_task_id: string; private_conversation_id: string; requested_expert_target: JsonObject;
        resolved_expert_target: JsonObject; requester_principal_id: string; permission_ceiling: JsonObject;
        input_digest: string; idempotency_key: string; approval_subject_digest: string;
        workflow_version_id: string; workflow_hash: string;
      }>(`SELECT binding.*,task.workflow_version_id,task.workflow_hash
        FROM business_exception_analysis_bindings binding
        JOIN business_tasks task ON task.tenant_id=binding.tenant_id AND task.id=binding.business_task_id
        WHERE binding.tenant_id=$1 AND binding.source_version_id=$2 FOR UPDATE`, [principal.tenantId, exception.source_version_id]);
      const bound = existing.rows[0];
      if (bound !== undefined) {
        if (bound.requester_principal_id === principal.userId
          && hashCanonical(bound.requested_expert_target) === hashCanonical(input.requestedExpertTarget)
          && hashCanonical(bound.resolved_expert_target) === hashCanonical(resolvedExpertTarget)
          && hashCanonical(bound.permission_ceiling) === hashCanonical(permissionCeiling)
          && bound.input_digest === inputDigest && bound.idempotency_key === input.idempotencyKey) {
          return createExceptionAnalysisTaskResponseSchema.parse({
            taskId: bound.business_task_id,
            conversationId: bound.private_conversation_id,
            workflowVersion: { id: bound.workflow_version_id, hash: bound.workflow_hash },
            approvalSubjectDigest: bound.approval_subject_digest,
            simulation: true,
          });
        }
        throw new GenewayError('ANALYSIS_BINDING_CONFLICT', 'Business exception already has a different analysis binding', 409);
      }
      if (Number(exception.aggregate_version) !== input.aggregateVersion) {
        throw new GenewayError('BUSINESS_EXCEPTION_STALE', 'Business exception snapshot is stale', 409);
      }

      const workflow = compileWorkflow(createExceptionAssistDraft(exception.resource_scope));
      await this.ensureVersions(client, principal.tenantId, workflow);
      const conversationId = id('conversation');
      const taskId = id('task');
      const approvalId = id('approval');
      const sourceAudience = snapshot.audience;
      const taskAudience = { kind: 'private_conversation', conversationId };
      const audienceScope = { kind: 'private-conversation', ids: [`conversation:${conversationId}`] };
      const budget = { maxRuntimeMs: 30_000, maxModelCost: 0, modelCallsAllowed: false };
      const expertTarget = { requested: input.requestedExpertTarget, resolved: resolvedExpertTarget };
      const inputRef = resolvedTaskInputRefSchema.parse({
        kind: 'business_exception_snapshot',
        businessExceptionId: exception.id,
        sourceVersionId: exception.source_version_id,
        sourceSha256: snapshot.canonical_sha256,
        canonicalizationVersion: snapshot.canonicalization_version,
        fixtureVersion: snapshot.fixture_version,
        sourceSystem: snapshot.source_system,
        sourceObjectRef: snapshot.source_object_ref,
        detectionWindow: snapshot.detection_window,
        resourceScope: snapshot.resource_scope,
        dataClass: snapshot.data_class,
        sourceAudience,
        taskAudience,
      });
      await client.query('INSERT INTO conversations (tenant_id,id,user_id) VALUES ($1,$2,$3)', [principal.tenantId, conversationId, principal.userId]);
      await client.query(`INSERT INTO business_tasks
        (tenant_id,id,conversation_id,capability_version_id,expert_catalog_version_id,harness_version_id,
         workflow_version_id,workflow_hash,requester_id,status,input_snapshot,input_digest,expert_target,
         permission_scope,audience_scope,budget,simulation,runtime_mode,business_decision_allowed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12,$13,$14,$15,true,'fake',false)`, [
        principal.tenantId, taskId, conversationId, EXCEPTION_ASSIST_CAPABILITY_VERSION_ID,
        EXPERT_CATALOG_VERSION_ID, EXCEPTION_ASSIST_HARNESS_VERSION_ID, workflow.id, workflow.hash,
        principal.userId, inputRef, inputDigest, expertTarget, permissionCeiling, audienceScope, budget,
      ]);
      for (const node of workflow.payload.nodes) {
        await client.query(`INSERT INTO business_task_steps
          (tenant_id,business_task_id,step_id,status,simulation,runtime_mode,business_decision_allowed)
          VALUES ($1,$2,$3,'queued',true,'fake',false)`, [principal.tenantId, taskId, node.id]);
      }
      const subject = buildApprovalSubject({
        taskId,
        requesterId: principal.userId,
        inputSnapshot: inputRef,
        expertTarget,
        expertCatalogVersionId: EXPERT_CATALOG_VERSION_ID,
        harnessVersionId: EXCEPTION_ASSIST_HARNESS_VERSION_ID,
        workflowVersionId: workflow.id,
        workflowHash: workflow.hash,
        permissionScope: permissionCeiling,
        audienceScope,
        budget,
        inputDigest,
      });
      const approvalSubjectDigest = hashCanonical(subject);
      const permissionIntersectionDigest = hashCanonical({
        tenantId: principal.tenantId, principalId: principal.userId,
        resourceScope: exception.resource_scope, dataClass: exception.data_class,
        sourceAudience, taskAudience,
      });
      await client.query(`INSERT INTO approval_versions
        (tenant_id,id,business_task_id,version,subject,subject_digest,status,requester_id,approver_policy_version,expires_at)
        VALUES ($1,$2,$3,1,$4,$5,'pending',$6,'trusted-local-exception-readonly/1',now()+interval '15 minutes')`, [
        principal.tenantId, approvalId, taskId, subject, approvalSubjectDigest, principal.userId,
      ]);
      await client.query(`INSERT INTO delegated_capabilities
        (tenant_id,id,business_task_id,principal_id,allowed_actions,resource_scopes,audience_scope,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes')`, [
        principal.tenantId, id('capability'), taskId, principal.userId,
        JSON.stringify(['R0', 'R1', 'A1']), JSON.stringify([exception.resource_scope]),
        JSON.stringify([`conversation:${conversationId}`]),
      ]);
      await client.query(`INSERT INTO policy_decisions
        (tenant_id,id,business_task_id,allow,reason_codes) VALUES ($1,$2,$3,true,$4)`, [
        principal.tenantId, id('policy'), taskId,
        JSON.stringify(['TRUSTED_LOCAL', 'BUSINESS_EXCEPTION_SOURCE_ALLOWED', 'PRIVATE_CONVERSATION_ALLOWED', 'ACTION_CEILING_A1']),
      ]);
      await client.query(`INSERT INTO business_exception_analysis_bindings
        (tenant_id,source_version_id,business_exception_id,business_task_id,requester_principal_id,
         private_conversation_id,requested_expert_target,resolved_expert_target,expert_catalog_version,
         capability_version_id,permission_ceiling,input_digest,idempotency_key,source_audience,task_audience,
         permission_intersection_digest,approval_subject_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
        principal.tenantId, exception.source_version_id, exception.id, taskId, principal.userId,
        conversationId, input.requestedExpertTarget, resolvedExpertTarget, EXPERT_CATALOG_VERSION_ID,
        EXCEPTION_ASSIST_CAPABILITY_VERSION_ID, permissionCeiling, inputDigest, input.idempotencyKey,
        sourceAudience, taskAudience, permissionIntersectionDigest, approvalSubjectDigest,
      ]);
      await this.createTaskEvidence(client, principal, taskId, conversationId, exception, snapshot);
      await this.appendTaskCreated(client, principal.tenantId, taskId, {
        approvalId, workflowVersionId: workflow.id, workflowHash: workflow.hash,
        businessExceptionId: exception.id, sourceVersionId: exception.source_version_id,
      });
      const updated = await client.query<ExceptionRow>(`UPDATE business_exceptions
        SET aggregate_version=aggregate_version+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND aggregate_version=$3 RETURNING *`, [
        principal.tenantId, exception.id, input.aggregateVersion,
      ]);
      const updatedException = updated.rows[0];
      if (updatedException === undefined) throw new GenewayError('BUSINESS_EXCEPTION_STALE', 'Business exception snapshot is stale', 409);
      await this.appendExceptionMutation(client, principal, updatedException, 'business_exception.analysis_bound', {
        sourceVersionId: exception.source_version_id,
        permissionIntersectionDigest,
        approvalSubjectDigest,
      });
      return createExceptionAnalysisTaskResponseSchema.parse({
        taskId,
        conversationId,
        workflowVersion: { id: workflow.id, hash: workflow.hash },
        approvalSubjectDigest,
        simulation: true,
      });
    });
  }

  private async createTaskEvidence(
    client: PoolClient,
    principal: Principal,
    taskId: string,
    conversationId: string,
    exception: ExceptionRow,
    snapshot: SourceSnapshotRow,
  ): Promise<void> {
    const source = JSON.parse(snapshot.canonical_bytes.toString('utf8')) as Readonly<{ values?: Readonly<Record<string, unknown>> }>;
    const values = source.values ?? {};
    for (const [key, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) continue;
      const jsonPointer = `/values/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      const valueSha256 = hashCanonical(value);
      const evidenceId = id('evidence');
      const evidenceSource = {
        kind: 'business_exception_snapshot',
        businessExceptionId: exception.id,
        sourceVersionId: exception.source_version_id,
        sourceSha256: snapshot.canonical_sha256,
        canonicalizationVersion: snapshot.canonicalization_version,
        jsonPointer,
        valueSha256,
      };
      await client.query(`INSERT INTO evidence_items
        (tenant_id,id,business_task_id,source_kind,source,source_excerpt,excerpt_sha256,
         resource_scope,data_class,audience,accessible,simulation,runtime_mode,business_decision_allowed)
        VALUES ($1,$2,$3,'business_exception_snapshot',$4,$5,$6,$7,'C1',$8,true,true,'fake',false)`, [
        principal.tenantId, evidenceId, taskId, evidenceSource, JSON.stringify(value), valueSha256,
        exception.resource_scope, `conversation:${conversationId}`,
      ]);
      await client.query(`INSERT INTO lineage_records
        (tenant_id,id,business_task_id,from_kind,from_id,to_kind,to_id,relation,metadata)
        VALUES ($1,$2,$3,'business_exception_snapshot',$4,'evidence',$5,'projected_as',$6)`, [
        principal.tenantId, id('lineage'), taskId, exception.source_version_id, evidenceId,
        { sourceSha256: snapshot.canonical_sha256, jsonPointer, valueSha256 },
      ]);
    }
  }

  private async getWithClient(client: PoolClient, principal: Principal, exceptionId: string): Promise<BusinessExceptionDetail> {
    const exception = await this.requireReadable(client, principal, exceptionId, false);
    return this.projectDetail(client, principal, exception);
  }

  private async projectDetail(client: PoolClient, principal: Principal, exception: ExceptionRow): Promise<BusinessExceptionDetail> {
    const snapshot = await this.requireSourceSnapshot(client, principal, exception);
    const canonical = JSON.parse(snapshot.canonical_bytes.toString('utf8')) as Readonly<{ values?: Readonly<Record<string, unknown>> }>;
    const evidence = Object.entries(canonical.values ?? {}).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null) return [];
      return [{
        sourceVersionId: snapshot.source_version_id,
        sourceSha256: snapshot.canonical_sha256,
        canonicalizationVersion: snapshot.canonicalization_version,
        jsonPointer: `/values/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        value,
        valueSha256: hashCanonical(value),
      }];
    });
    const binding = await client.query('SELECT 1 FROM business_exception_analysis_bindings WHERE tenant_id=$1 AND source_version_id=$2', [
      principal.tenantId, exception.source_version_id,
    ]);
    return businessExceptionDetailSchema.parse({
      ...this.projectListItem(exception),
      sourceObjectRef: exception.source_object_ref,
      detectionWindow: exception.detection_window,
      acknowledgedAt: exception.acknowledged_at?.toISOString() ?? null,
      ownerDisplayState: exception.owner_principal_id === null ? 'unassigned'
        : exception.owner_principal_id === principal.userId ? 'mine' : 'assigned',
      analysisDisplayState: binding.rowCount === 1 ? 'task_bound' : 'not_requested',
      evidence,
    });
  }

  private projectListItem(row: ExceptionRow): BusinessExceptionListItem {
    return businessExceptionListItemSchema.parse({
      id: row.id,
      exceptionType: row.exception_type,
      summary: row.summary,
      severity: row.severity,
      status: row.status,
      resourceScope: row.resource_scope,
      dataClass: row.data_class,
      detectedAt: row.detected_at.toISOString(),
      aggregateVersion: Number(row.aggregate_version),
      simulation: row.simulation,
    });
  }

  private readAuthorizationSql(alias: string): string {
    return `EXISTS (SELECT 1 FROM users principal_user
      WHERE principal_user.tenant_id=${alias}.tenant_id AND principal_user.id=$6)
      AND EXISTS (SELECT 1 FROM roles role_binding
        WHERE role_binding.tenant_id=${alias}.tenant_id AND role_binding.user_id=$6
          AND role_binding.role='solution_reviewer')
      AND EXISTS (SELECT 1 FROM resource_scopes readable_scope
        WHERE readable_scope.tenant_id=${alias}.tenant_id AND readable_scope.user_id=$6
          AND (${alias}.resource_scope=readable_scope.resource_scope
            OR ${alias}.resource_scope LIKE readable_scope.resource_scope || '/%'))`;
  }

  private async requireReadable(
    client: PoolClient,
    principal: Principal,
    exceptionId: string,
    forUpdate: boolean,
  ): Promise<ExceptionRow> {
    const result = await client.query<ExceptionRow>(`SELECT e.* FROM business_exceptions e
      WHERE e.tenant_id=$1 AND e.id=$2
        AND EXISTS (SELECT 1 FROM roles role_binding WHERE role_binding.tenant_id=e.tenant_id
          AND role_binding.user_id=$3 AND role_binding.role='solution_reviewer')
        AND EXISTS (SELECT 1 FROM resource_scopes readable_scope WHERE readable_scope.tenant_id=e.tenant_id
          AND readable_scope.user_id=$3 AND (e.resource_scope=readable_scope.resource_scope
            OR e.resource_scope LIKE readable_scope.resource_scope || '/%'))
      ${forUpdate ? 'FOR UPDATE' : 'FOR SHARE'}`, [principal.tenantId, exceptionId, principal.userId]);
    const row = result.rows[0];
    if (row === undefined) throw new GenewayError('BUSINESS_EXCEPTION_NOT_FOUND', 'Business exception was not found', 404);
    return row;
  }

  private async requireSourceSnapshot(client: PoolClient, principal: Principal, exception: ExceptionRow): Promise<SourceSnapshotRow> {
    const result = await client.query<SourceSnapshotRow>(`SELECT snapshot.* FROM business_exception_source_snapshots snapshot
      WHERE snapshot.tenant_id=$1 AND snapshot.source_version_id=$2
        AND snapshot.business_exception_id=$3 AND snapshot.resource_scope=$4 AND snapshot.data_class=$5
        AND snapshot.canonical_sha256=$6
        AND snapshot.audience=jsonb_build_object('kind','resource_exception','businessExceptionId',$3,
          'resourceScope',$4,'dataClass',$5)
        AND EXISTS (SELECT 1 FROM resource_scopes readable_scope WHERE readable_scope.tenant_id=snapshot.tenant_id
          AND readable_scope.user_id=$7 AND (snapshot.resource_scope=readable_scope.resource_scope
            OR snapshot.resource_scope LIKE readable_scope.resource_scope || '/%'))
      FOR SHARE`, [
      principal.tenantId, exception.source_version_id, exception.id, exception.resource_scope,
      exception.data_class, exception.fixture_sha256, principal.userId,
    ]);
    const row = result.rows[0];
    if (row === undefined || sha256(row.canonical_bytes) !== row.canonical_sha256) {
      throw new GenewayError('BUSINESS_EXCEPTION_SOURCE_INVALID', 'Business exception source authority is unavailable', 409);
    }
    return row;
  }

  private async scopeIsAuthorized(client: PoolClient, principal: Principal, scope: string): Promise<boolean> {
    const result = await client.query(`SELECT 1 FROM resource_scopes WHERE tenant_id=$1 AND user_id=$2
      AND ($3=resource_scope OR $3 LIKE resource_scope || '/%')`, [principal.tenantId, principal.userId, scope]);
    return result.rowCount === 1;
  }

  private async authorizationEpoch(client: PoolClient, principal: Principal): Promise<string> {
    const roles = await client.query<{ role: string }>('SELECT role FROM roles WHERE tenant_id=$1 AND user_id=$2 ORDER BY role', [principal.tenantId, principal.userId]);
    const scopes = await client.query<{ resource_scope: string }>('SELECT resource_scope FROM resource_scopes WHERE tenant_id=$1 AND user_id=$2 ORDER BY resource_scope', [principal.tenantId, principal.userId]);
    const user = await client.query('SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2', [principal.tenantId, principal.userId]);
    if (user.rowCount !== 1) throw new GenewayError('PRINCIPAL_NOT_FOUND', 'Principal is not available', 403);
    return hashCanonical({
      tenantId: principal.tenantId,
      userId: principal.userId,
      trust: principal.trust,
      policyVersion: 'business-exception-read/v1',
      roles: roles.rows.map((row) => row.role),
      resourceScopes: scopes.rows.map((row) => row.resource_scope),
    });
  }

  private async createQuerySnapshot(
    client: PoolClient,
    principal: Principal,
    authorizationEpoch: string,
    canonicalQuery: JsonObject,
    items: readonly Readonly<{ objectId: string; sortKey: JsonObject }>[] ,
  ): Promise<QuerySnapshotRow> {
    await client.query('DELETE FROM query_snapshots WHERE expires_at<=now()');
    const clock = await client.query<{ as_of: Date }>('SELECT transaction_timestamp() as_of');
    const asOf = clock.rows[0]?.as_of;
    if (asOf === undefined) throw new GenewayError('QUERY_SNAPSHOT_FAILED', 'Could not establish query snapshot time', 500);
    const snapshot: QuerySnapshotRow = {
      id: id('query'), query_kind: 'business_exceptions', authorization_epoch: authorizationEpoch,
      canonical_query: canonicalQuery, query_version: QUERY_VERSION, field_mask_version: FIELD_MASK_VERSION,
      as_of: asOf, expires_at: new Date(asOf.getTime() + QUERY_SNAPSHOT_TTL_MS),
    };
    await client.query(`INSERT INTO query_snapshots
      (tenant_id,id,principal_id,query_kind,authorization_epoch,canonical_query,query_version,field_mask_version,as_of,expires_at)
      VALUES ($1,$2,$3,'business_exceptions',$4,$5,$6,$7,$8,$9)`, [
      principal.tenantId, snapshot.id, principal.userId, authorizationEpoch, canonicalQuery,
      QUERY_VERSION, FIELD_MASK_VERSION, snapshot.as_of, snapshot.expires_at,
    ]);
    for (const [position, item] of items.entries()) {
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
    cursor: CursorPayload,
    authorizationEpoch: string,
    canonicalQuery: JsonObject,
  ): Promise<QuerySnapshotRow> {
    const result = await client.query<QuerySnapshotRow>(`SELECT id,query_kind,authorization_epoch,canonical_query,
      query_version,field_mask_version,as_of,expires_at FROM query_snapshots
      WHERE tenant_id=$1 AND id=$2 AND principal_id=$3`, [principal.tenantId, cursor.snapshotId, principal.userId]);
    const snapshot = result.rows[0];
    if (snapshot === undefined || snapshot.query_kind !== 'business_exceptions'
      || snapshot.authorization_epoch !== authorizationEpoch
      || hashCanonical(snapshot.canonical_query) !== hashCanonical(canonicalQuery)
      || snapshot.query_version !== QUERY_VERSION || snapshot.field_mask_version !== FIELD_MASK_VERSION
      || snapshot.expires_at.getTime() <= Date.now() || snapshot.expires_at.getTime() !== cursor.expiresAt) {
      throw new GenewayError('CURSOR_INVALID', 'Pagination cursor is invalid or expired', 409);
    }
    return snapshot;
  }

  private async readPage(
    client: PoolClient,
    principal: Principal,
    snapshot: QuerySnapshotRow,
    position: number,
    limit: number,
  ): Promise<Readonly<{ items: readonly BusinessExceptionListItem[]; nextCursor: string | null }>> {
    const items: BusinessExceptionListItem[] = [];
    let scanPosition = position;
    let nextVisiblePosition: number | null = null;
    scan: while (true) {
      const rows = await client.query<{ position: number; object_id: string }>(`SELECT position,object_id
        FROM query_snapshot_items WHERE tenant_id=$1 AND query_snapshot_id=$2 AND position>=$3
        ORDER BY position LIMIT 100`, [principal.tenantId, snapshot.id, scanPosition]);
      if (rows.rows.length === 0) break;
      for (const row of rows.rows) {
        scanPosition = row.position + 1;
        try {
          const exception = await this.requireReadable(client, principal, row.object_id, false);
          if (items.length < limit) items.push(this.projectListItem(exception));
          else {
            nextVisiblePosition = row.position;
            break scan;
          }
        } catch (error) {
          if (!(error instanceof GenewayError) || error.code !== 'BUSINESS_EXCEPTION_NOT_FOUND') throw error;
        }
      }
      if (rows.rows.length < 100) break;
    }
    return {
      items,
      nextCursor: nextVisiblePosition === null ? null
        : this.issueCursor(snapshot.id, nextVisiblePosition, snapshot.expires_at.getTime()),
    };
  }

  private issueCursor(snapshotId: string, position: number, expiresAt: number): string {
    const encoded = Buffer.from(JSON.stringify({ snapshotId, position, expiresAt }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.cursorHmacSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private parseCursor(cursor: string): CursorPayload {
    const [encoded, signature, extra] = cursor.split('.');
    try {
      if (encoded === undefined || signature === undefined || extra !== undefined
        || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]+$/u.test(signature)) throw new Error('invalid');
      const encodedBytes = Buffer.from(encoded, 'base64url');
      const actual = Buffer.from(signature, 'base64url');
      if (encodedBytes.toString('base64url') !== encoded || actual.toString('base64url') !== signature) throw new Error('invalid');
      const expected = createHmac('sha256', this.cursorHmacSecret).update(encoded).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid');
      const value = JSON.parse(encodedBytes.toString('utf8')) as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'expiresAt,position,snapshotId'
        || typeof value.snapshotId !== 'string' || !Number.isSafeInteger(value.position)
        || Number(value.position) < 0 || !Number.isSafeInteger(value.expiresAt)
        || Number(value.expiresAt) <= Date.now()) throw new Error('invalid');
      return { snapshotId: value.snapshotId, position: Number(value.position), expiresAt: Number(value.expiresAt) };
    } catch {
      throw new GenewayError('CURSOR_INVALID', 'Pagination cursor is invalid or expired', 409);
    }
  }

  private resolveExpertTarget(target: CreateExceptionAnalysisTaskInput['requestedExpertTarget']): JsonObject {
    if (target.mode === 'auto') return { mode: 'expert', expertId: 'expert.operations.analyst', resolution: 'automatic' };
    if (target.mode === 'expert' && target.expertId === 'expert.operations.analyst') return { ...target, resolution: 'explicit' };
    if (target.mode === 'team' && target.teamId === 'team.operations.exception') return { ...target, resolution: 'explicit' };
    throw new GenewayError('EXPERT_NOT_ALLOWED', 'Expert or team is outside the exception capability allowlist', 422);
  }

  private async ensureVersions(
    client: PoolClient,
    tenantId: string,
    workflow: ReturnType<typeof compileWorkflow>,
  ): Promise<void> {
    await client.query(`INSERT INTO capability_versions (tenant_id,id,capability_id,version,spec)
      VALUES ($1,$2,'operations.exception-assist.v1',1,$3) ON CONFLICT DO NOTHING`, [
      tenantId, EXCEPTION_ASSIST_CAPABILITY_VERSION_ID,
      { state: 'shadow', fixtureOnly: true, routingPolicyVersion: EXCEPTION_ASSIST_ROUTING_POLICY_VERSION, actionCeiling: 'A1' },
    ]);
    await client.query(`INSERT INTO expert_catalog_versions (tenant_id,id,version,catalog)
      VALUES ($1,$2,1,$3) ON CONFLICT DO NOTHING`, [tenantId, EXPERT_CATALOG_VERSION_ID, {
      routingPolicyVersion: EXCEPTION_ASSIST_ROUTING_POLICY_VERSION,
      experts: [{ id: 'expert.operations.analyst', name: '运营分析专家', healthy: true }],
      teams: [{ id: 'team.operations.exception', name: '异常分析专家团', expertIds: ['expert.operations.analyst'], healthy: true }],
    }]);
    await client.query(`INSERT INTO harness_versions
      (tenant_id,id,capability_version_id,version,spec) VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING`, [
      tenantId, EXCEPTION_ASSIST_HARNESS_VERSION_ID, EXCEPTION_ASSIST_CAPABILITY_VERSION_ID,
      { runtime: 'fake', verifier: 'claim-evidence-minimum/2', maxSteps: 7, externalRoutesAllowed: false },
    ]);
    await client.query(`INSERT INTO workflow_versions
      (tenant_id,id,workflow_hash,canonicalization_version,canonical_json) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`, [
      tenantId, workflow.id, workflow.hash, workflow.canonicalizationVersion, JSON.parse(workflow.canonicalJson) as unknown,
    ]);
  }

  private async appendExceptionMutation(
    client: PoolClient,
    principal: Principal,
    exception: ExceptionRow,
    eventType: 'business_exception.acknowledged' | 'business_exception.analysis_bound',
    payload: JsonObject,
  ): Promise<void> {
    const sequence = await client.query<{ next: string }>(`SELECT coalesce(max(sequence),0)+1 AS next
      FROM business_exception_events WHERE tenant_id=$1 AND business_exception_id=$2`, [principal.tenantId, exception.id]);
    const eventId = id('exception_event');
    const eventPayload = { ...payload, aggregateVersion: Number(exception.aggregate_version), simulation: true };
    await client.query(`INSERT INTO business_exception_events
      (tenant_id,id,business_exception_id,sequence,event_type,aggregate_version,correlation_id,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$2,$7)`, [
      principal.tenantId, eventId, exception.id, Number(sequence.rows[0]?.next),
      eventType, Number(exception.aggregate_version), eventPayload,
    ]);
    await client.query(`INSERT INTO audit_events
      (tenant_id,id,principal_id,event_type,resource_type,resource_id,outcome,reason_code,details)
      VALUES ($1,$2,$3,$4,'business_exception',$5,'allowed','AUTHORIZED_MUTATION',$6)`, [
      principal.tenantId, id('audit'), principal.userId, eventType, exception.id, eventPayload,
    ]);
    await client.query(`INSERT INTO outbox_events
      (tenant_id,id,business_task_id,business_exception_id,event_id,event_type,payload)
      VALUES ($1,$2,NULL,$3,$4,$5,$6)`, [
      principal.tenantId, id('outbox'), exception.id, eventId, eventType, eventPayload,
    ]);
  }

  private async appendTaskCreated(client: PoolClient, tenantId: string, taskId: string, payload: JsonObject): Promise<void> {
    const update = await client.query<{ aggregate_version: string }>(`UPDATE business_tasks
      SET aggregate_version=aggregate_version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2
      RETURNING aggregate_version::text`, [tenantId, taskId]);
    const aggregateVersion = Number(update.rows[0]?.aggregate_version);
    const eventId = id('event');
    const eventPayload = { ...payload, simulation: true, runtimeMode: 'fake', businessDecisionAllowed: false };
    await client.query(`INSERT INTO business_task_events
      (tenant_id,id,business_task_id,sequence,event_type,aggregate_version,correlation_id,payload,simulation,runtime_mode,business_decision_allowed)
      VALUES ($1,$2,$3,1,'business_task.created',$4,$3,$5,true,'fake',false)`, [
      tenantId, eventId, taskId, aggregateVersion, eventPayload,
    ]);
    await client.query(`INSERT INTO outbox_events
      (tenant_id,id,business_task_id,business_exception_id,event_id,event_type,payload)
      VALUES ($1,$2,$3,NULL,$4,'business_task.created',$5)`, [tenantId, id('outbox'), taskId, eventId, eventPayload]);
  }

  private async withTransaction<T>(effect: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await effect(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
