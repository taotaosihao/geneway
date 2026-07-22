import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for migration integration tests');

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });
const migrationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);

const migration = async (filename: string): Promise<string> => readFile(path.join(migrationRoot, filename), 'utf8');
const quoted = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

async function inIsolatedSchema(operation: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  const schema = `migration_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query(`CREATE SCHEMA ${quoted(schema)}`);
    await client.query(`SET search_path TO ${quoted(schema)}`);
    await operation(client);
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`).catch(() => undefined);
    client.release();
  }
}

async function applyBase(client: PoolClient): Promise<void> {
  await client.query(await migration('0001_gate_0_1.sql'));
  await client.query(await migration('0002_gate_0_2a_storage.sql'));
}

async function applyGateMigration(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(await migration('0003_gate_0_2a_delivery_evidence.sql'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applyRecoveryMigration(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(await migration('0004_gate_0_2a_recovery.sql'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function applyQuerySnapshotMigration(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(await migration('0005_gate_0_2b_query_snapshots.sql'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seedLegacyAuthority(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO tenants (id,name) VALUES ('tenant_a','Tenant A');
    INSERT INTO users (tenant_id,id,display_name) VALUES
      ('tenant_a','user_a','User A'),
      ('tenant_a','user_b','User B');
    INSERT INTO conversations (tenant_id,id,user_id) VALUES
      ('tenant_a','conversation_a','user_a'),
      ('tenant_a','conversation_b','user_b');
    INSERT INTO messages (tenant_id,id,conversation_id,author,body)
      VALUES ('tenant_a','message_a','conversation_a','user','legacy message');
    INSERT INTO capability_versions (tenant_id,id,capability_id,version,spec)
      VALUES ('tenant_a','capability_v1','solution.analysis.v1',1,'{}');
    INSERT INTO expert_catalog_versions (tenant_id,id,version,catalog)
      VALUES ('tenant_a','experts_v1',1,'{}');
    INSERT INTO harness_versions (tenant_id,id,capability_version_id,version,spec)
      VALUES ('tenant_a','harness_v1','capability_v1',1,'{}');
    INSERT INTO workflow_versions (tenant_id,id,workflow_hash,canonicalization_version,canonical_json)
      VALUES ('tenant_a','workflow_v1','${hashA}','RFC8785/JCS-1','{}');
    INSERT INTO business_tasks
      (tenant_id,id,conversation_id,capability_version_id,expert_catalog_version_id,harness_version_id,
       workflow_version_id,workflow_hash,requester_id,status,input_snapshot,expert_target,permission_scope,
       audience_scope,budget,simulation,runtime_mode,business_decision_allowed)
    VALUES
      ('tenant_a','task_legacy','conversation_a','capability_v1','experts_v1','harness_v1','workflow_v1',
       '${hashA}','user_a','completed','{"fixtureRef":"fixture:solution-analysis:v1"}','{}',
       '{"resourceScopes":["fixture:solution-analysis:v1"]}','{}','{}',true,'fake',false),
      ('tenant_a','task_run','conversation_a','capability_v1','experts_v1','harness_v1','workflow_v1',
       '${hashA}','user_a','approved','{"kind":"document_snapshot","documentSnapshotId":"snapshot_a"}','{}',
       '{"resourceScopes":["artifact:artifact_source"]}','{}','{}',true,'fake',false),
      ('tenant_a','task_other','conversation_b','capability_v1','experts_v1','harness_v1','workflow_v1',
       '${hashA}','user_b','approved','{"kind":"fixture"}','{}',
       '{"resourceScopes":["fixture:solution-analysis:v1"]}','{}','{}',true,'fake',false);
    INSERT INTO approval_versions
      (tenant_id,id,business_task_id,version,subject,subject_digest,status,requester_id,
       approver_policy_version,decision_by,decision_at,expires_at)
      VALUES ('tenant_a','approval_a','task_legacy',1,'{}','${hashA}','approved','user_a','policy/1','user_a',now(),now()+interval '1 day');
    INSERT INTO minimal_evidence_refs
      (tenant_id,id,business_task_id,source_id,source_excerpt,source_hash,resource_scope,data_class,
       accessible,simulation,runtime_mode,business_decision_allowed)
      VALUES ('tenant_a','evidence_legacy','task_legacy','fixture-source','legacy excerpt','${hashB}',
        'fixture:solution-analysis:v1','C1',true,true,'fake',false);
    INSERT INTO result_claims
      (tenant_id,id,business_task_id,text,status,evidence_ref_id,rejection_code,simulation,runtime_mode,business_decision_allowed)
      VALUES
        ('tenant_a','claim_published','task_legacy','supported claim','published','evidence_legacy',null,true,'fake',false),
        ('tenant_a','claim_rejected','task_legacy','unsupported claim','rejected',null,'NO_EVIDENCE',true,'fake',false);
    INSERT INTO artifacts
      (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,content_sha256)
      VALUES
        ('tenant_a','artifact_source','conversation_a','user_a','source_document','source.md','text/markdown',100,'${hashA}'),
        ('tenant_a','artifact_orphan','conversation_a','user_a','source_document','orphan.md','text/markdown',50,'${hashB}');
    INSERT INTO artifact_manifests
      (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,retention_policy)
      VALUES ('tenant_a','manifest_source','artifact_source','bucket-a','source/key','source.md','text/markdown',100,'${hashA}','gate0.2a-internal/v1');
    INSERT INTO artifact_states
      (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status,state_version)
      VALUES ('tenant_a','artifact_source','active','verified','active','2099-01-01T00:00:00Z','in_sync',1);
    INSERT INTO document_snapshots
      (tenant_id,id,conversation_id,artifact_id,manifest_id,display_name,media_type,size_bytes,content_sha256,
       data_class,audience,resource_scope,trust,simulation_profile,profile_registry_version,created_by)
      VALUES ('tenant_a','snapshot_a','conversation_a','artifact_source','manifest_source','source.md','text/markdown',100,
       '${hashA}','C1','{"kind":"private-conversation","conversationId":"conversation_a"}',
       'artifact:artifact_source','untrusted_text','solution-analysis-demo/v2','gate0.2a-profile-registry/1','user_a');
    INSERT INTO idempotency_records (tenant_id,operation,idempotency_key,request_digest,response) VALUES
      ('tenant_a','conversation.create','legacy-key-conversation','d','{"id":"conversation_a"}'),
      ('tenant_a','conversation.message.create','legacy-key-message','d','{"id":"message_a"}'),
      ('tenant_a','business-task.create','legacy-key-task','d','{"taskId":"task_legacy"}'),
      ('tenant_a','approval.decide','legacy-key-approval','d','{"approvalId":"approval_a"}'),
      ('tenant_a','business-task.execute','legacy-key-execute','d','{"taskId":"task_legacy"}');
  `);
}

describe('0003 Gate 0.2A delivery/evidence migration', () => {
  beforeAll(async () => pool.query('SELECT 1'));
  afterAll(async () => pool.end());

  it('upgrades populated 0001/0002 authority data without inventing ownership or lineage', async () => {
    await inIsolatedSchema(async (client) => {
      await applyBase(client);
      await seedLegacyAuthority(client);
      await applyGateMigration(client);

      const principals = await client.query<{ operation: string; principal_id: string }>(
        `SELECT operation,principal_id FROM idempotency_records WHERE tenant_id='tenant_a' ORDER BY operation`,
      );
      expect(principals.rows).toHaveLength(5);
      expect(principals.rows.every((row) => row.principal_id === 'user_a')).toBe(true);

      await client.query(`INSERT INTO idempotency_records
        (tenant_id,principal_id,operation,idempotency_key,request_digest,response)
        VALUES
          ('tenant_a','user_a','test.operation','same-principal-aware-key','d','{}'),
          ('tenant_a','user_b','test.operation','same-principal-aware-key','d','{}')`);

      const artifact = await client.query(`SELECT root_artifact_id,data_class,audience,resource_scope
        FROM artifacts WHERE tenant_id='tenant_a' AND id='artifact_orphan'`);
      expect(artifact.rows[0]).toEqual({
        root_artifact_id: 'artifact_orphan',
        data_class: 'C1',
        audience: { kind: 'private-conversation', conversationId: 'conversation_a' },
        resource_scope: 'artifact:artifact_orphan',
      });

      const backfill = await client.query(`SELECT
        (SELECT count(*)::int FROM claims WHERE tenant_id='tenant_a') AS claims,
        (SELECT count(*)::int FROM evidence_items WHERE tenant_id='tenant_a') AS evidence,
        (SELECT count(*)::int FROM evidence_links WHERE tenant_id='tenant_a') AS links,
        (SELECT count(*)::int FROM lineage_records WHERE tenant_id='tenant_a') AS lineage,
        (SELECT count(*)::int FROM lineage_records WHERE tenant_id='tenant_a' AND from_kind='candidate') AS invented_candidates`);
      expect(backfill.rows[0]).toEqual({ claims: 2, evidence: 1, links: 1, lineage: 2, invented_candidates: 0 });

      await expect(client.query(`INSERT INTO result_claims
        (tenant_id,id,business_task_id,text,status,evidence_ref_id,rejection_code,simulation,runtime_mode,business_decision_allowed)
        VALUES ('tenant_a','late_legacy','task_legacy','late','rejected',null,'NO',true,'fake',false)`))
        .rejects.toThrow(/legacy result tables are read-only/u);
      await expect(client.query(`UPDATE claims SET text='changed' WHERE tenant_id='tenant_a' AND id='claim_published'`))
        .rejects.toThrow(/immutable/u);
    });
  });

  it('0004 replaces anonymous report intent checks without dropping resource or audience binding', async () => {
    await inIsolatedSchema(async (client) => {
      await applyBase(client);
      await seedLegacyAuthority(client);
      await applyGateMigration(client);
      await applyRecoveryMigration(client);
      const constraints = await client.query<{ conname: string; definition: string }>(`SELECT conname,pg_get_constraintdef(oid) definition
        FROM pg_constraint WHERE conrelid='report_publish_intents'::regclass AND contype='c'
          AND conname IN (
            'report_publish_intents_resource_scope_check',
            'report_publish_intents_audience_check',
            'report_publish_intents_state_check'
          ) ORDER BY conname`);
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        'report_publish_intents_audience_check',
        'report_publish_intents_resource_scope_check',
        'report_publish_intents_state_check',
      ]);
      expect(constraints.rows.find((row) => row.conname.endsWith('resource_scope_check'))?.definition)
        .toMatch(/resource_scope.*artifact:.*root_artifact_id/u);
      expect(constraints.rows.find((row) => row.conname.endsWith('audience_check'))?.definition)
        .toMatch(/audience.*conversation:.*conversation_id/u);
      expect(constraints.rows.find((row) => row.conname.endsWith('state_check'))?.definition)
        .toMatch(/delete_pending.*deleted/u);

      await client.query(`INSERT INTO outbox_events
        (tenant_id,id,business_task_id,event_id,event_type,payload)
        VALUES ('tenant_a','outbox_0004_report','task_run','event_0004_report','workflow.execute.requested','{}')`);
      await client.query(`INSERT INTO execution_attempts
        (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,worker_instance_id,
         status,fencing_token,lease_until)
        VALUES ('tenant_a','attempt_0004_report','task_run',1,'event_0004_report','gate0.2a-worker','gate0.2a-local',
          'worker-0004-report','running',1,now()+interval '1 minute')`);
      await client.query(`UPDATE business_tasks SET current_execution_attempt_id='attempt_0004_report',execution_version=1,
        execution_fencing_token=1,status='running' WHERE tenant_id='tenant_a' AND id='task_run'`);
      await client.query(`INSERT INTO attempt_output_candidates
        (tenant_id,id,business_task_id,execution_attempt_id,execution_version,fencing_token,worker_instance_id,
         payload,payload_sha256,idempotency_key)
        VALUES ('tenant_a','candidate_0004_report','task_run','attempt_0004_report',1,1,'worker-0004-report',
          '{}','${hashC}','candidate-0004-report')`);

      const insertReportIntent = (id: string, resourceScope: string, audience: string) => client.query(`INSERT INTO report_publish_intents
        (tenant_id,id,business_task_id,execution_attempt_id,candidate_id,source_document_snapshot_id,root_artifact_id,
         conversation_id,owner_user_id,resource_scope,data_class,audience,artifact_id,manifest_id,storage_bucket,
         storage_key,template_id,template_sha256,render_input_sha256,size_bytes,content_sha256,status)
        VALUES ('tenant_a',$1,'task_run','attempt_0004_report','candidate_0004_report','snapshot_a','artifact_source',
          'conversation_a','user_a',$2,'C1',$3,'artifact_0004_report','manifest_0004_report','bucket-a',
          'report/0004-key','gate0.2a-report/v1','${hashA}','${hashB}',256,'${hashC}','prepared')`, [
        id, resourceScope, audience,
      ]);

      await expect(insertReportIntent('report_0004_bad_scope', 'artifact:wrong', 'conversation:conversation_a'))
        .rejects.toThrow(/report_publish_intents_resource_scope_check/u);
      await expect(insertReportIntent('report_0004_bad_audience', 'artifact:artifact_source', 'conversation:wrong'))
        .rejects.toThrow(/report_publish_intents_audience_check/u);
      await insertReportIntent('report_0004', 'artifact:artifact_source', 'conversation:conversation_a');
      await client.query(`UPDATE report_publish_intents
        SET status='reconcile_required',failure_code='UNPUBLISHED_REPORT_ORPHAN',state_version=2,updated_at=now()
        WHERE tenant_id='tenant_a' AND id='report_0004'`);
      await client.query(`UPDATE report_publish_intents
        SET status='delete_pending',state_version=3,updated_at=now()
        WHERE tenant_id='tenant_a' AND id='report_0004'`);
      await client.query(`UPDATE report_publish_intents
        SET status='deleted',state_version=4,deleted_at=now(),updated_at=now()
        WHERE tenant_id='tenant_a' AND id='report_0004'`);
      const transitioned = await client.query(`SELECT status,state_version::int version,(deleted_at IS NOT NULL) deleted
        FROM report_publish_intents WHERE tenant_id='tenant_a' AND id='report_0004'`);
      expect(transitioned.rows).toEqual([{ status: 'deleted', version: 4, deleted: true }]);
    });
  });

  it('enforces same-attempt delivery/candidate correlation and deferred evidence support', async () => {
    await inIsolatedSchema(async (client) => {
      await applyBase(client);
      await seedLegacyAuthority(client);
      await applyGateMigration(client);

      await client.query(`INSERT INTO outbox_events
        (tenant_id,id,business_task_id,event_id,event_type,payload)
        VALUES ('tenant_a','outbox_execute','task_run','event_execute','workflow.execute.requested','{}')`);
      await client.query(`INSERT INTO execution_attempts
        (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,worker_instance_id,
         status,fencing_token,lease_until)
        VALUES ('tenant_a','attempt_run','task_run',1,'event_execute','gate0.2a-worker','gate0.2a-local',
          'worker-1','running',1,now()+interval '1 minute')`);
      await client.query(`UPDATE business_tasks SET current_execution_attempt_id='attempt_run',execution_version=1,
        execution_fencing_token=1,status='running' WHERE tenant_id='tenant_a' AND id='task_run'`);
      await client.query(`INSERT INTO outbox_deliveries
        (tenant_id,id,business_task_id,consumer,deployment_id,event_id,status,execution_attempt_id,
         worker_instance_id,fencing_token,lease_until)
        VALUES ('tenant_a','delivery_run','task_run','gate0.2a-worker','gate0.2a-local','event_execute','leased',
          'attempt_run','worker-1',1,now()+interval '1 minute')`);
      await client.query(`INSERT INTO inbox_events
        (tenant_id,consumer,deployment_id,event_id,delivery_id,business_task_id,execution_attempt_id,
         worker_instance_id,fencing_token,status)
        VALUES ('tenant_a','gate0.2a-worker','gate0.2a-local','event_execute','delivery_run','task_run',
          'attempt_run','worker-1',1,'received')`);

      await client.query('BEGIN');
      await client.query(`UPDATE execution_attempts SET worker_instance_id='worker-2',fencing_token=2
        WHERE tenant_id='tenant_a' AND id='attempt_run'`);
      await client.query(`UPDATE outbox_deliveries SET worker_instance_id='worker-2',fencing_token=2,delivery_count=2,
        lease_until=now()+interval '1 minute',updated_at=now()
        WHERE tenant_id='tenant_a' AND id='delivery_run'`);
      await client.query(`UPDATE inbox_events SET worker_instance_id='worker-2',fencing_token=2
        WHERE tenant_id='tenant_a' AND consumer='gate0.2a-worker' AND event_id='event_execute'`);
      await client.query(`UPDATE business_tasks SET execution_fencing_token=2
        WHERE tenant_id='tenant_a' AND id='task_run'`);
      await client.query('COMMIT');

      await client.query(`INSERT INTO attempt_output_candidates
        (tenant_id,id,business_task_id,execution_attempt_id,execution_version,fencing_token,worker_instance_id,
         payload,payload_sha256,idempotency_key)
        VALUES ('tenant_a','candidate_run','task_run','attempt_run',1,2,'worker-2','{}','${hashC}','candidate-submit-1')`);

      await client.query(`INSERT INTO outbox_events
        (tenant_id,id,business_task_id,event_id,event_type,payload)
        VALUES ('tenant_a','outbox_other','task_other','event_other','workflow.execute.requested','{}')`);
      await client.query(`INSERT INTO execution_attempts
        (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,worker_instance_id,
         status,fencing_token,lease_until)
        VALUES ('tenant_a','attempt_other','task_other',1,'event_other','gate0.2a-worker','gate0.2a-local',
          'worker-1','running',1,now()+interval '1 minute')`);
      await expect(client.query(`INSERT INTO attempt_output_candidates
        (tenant_id,id,business_task_id,execution_attempt_id,execution_version,fencing_token,worker_instance_id,
         payload,payload_sha256,idempotency_key)
        VALUES ('tenant_a','candidate_wrong','task_run','attempt_other',1,1,'worker-1','{}','${hashC}','candidate-submit-2')`))
        .rejects.toThrow(/foreign key/u);

      const source = JSON.stringify({
        kind: 'document_snapshot',
        documentSnapshotId: 'snapshot_a',
        artifactId: 'artifact_source',
        startByte: 0,
        endByteExclusive: 10,
        snapshotSha256: hashA,
        excerptSha256: hashB,
        extractionVersion: 'raw-utf8-byte-range/1',
      });
      await client.query(`INSERT INTO evidence_items
        (tenant_id,id,business_task_id,candidate_id,source_kind,source,source_excerpt,excerpt_sha256,
         resource_scope,data_class,audience,accessible,simulation,runtime_mode,business_decision_allowed)
        VALUES ('tenant_a','evidence_run','task_run','candidate_run','document_snapshot',$1,'0123456789','${hashB}',
          'artifact:artifact_source','C1','conversation:conversation_a',true,true,'fake',false)`, [source]);

      await client.query('BEGIN');
      await client.query(`INSERT INTO claims
        (tenant_id,id,business_task_id,candidate_id,text,status,resource_scope,data_class,audience,
         simulation,runtime_mode,business_decision_allowed)
        VALUES ('tenant_a','claim_run','task_run','candidate_run','verified claim','published',
          'artifact:artifact_source','C1','conversation:conversation_a',true,'fake',false)`);
      await client.query(`INSERT INTO evidence_links
        (tenant_id,id,business_task_id,claim_id,evidence_id,relation)
        VALUES ('tenant_a','link_run','task_run','claim_run','evidence_run','supports')`);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`INSERT INTO claims
        (tenant_id,id,business_task_id,candidate_id,text,status,resource_scope,data_class,audience,
         simulation,runtime_mode,business_decision_allowed)
        VALUES ('tenant_a','claim_without_evidence','task_run','candidate_run','unsupported published claim','published',
          'artifact:artifact_source','C1','conversation:conversation_a',true,'fake',false)`);
      await expect(client.query('COMMIT')).rejects.toThrow(/requires a same-task accessible supports evidence/u);
      await client.query('ROLLBACK');
    });
  });

  it('publishes a report intent only when source, attempt, artifact, manifest and state agree', async () => {
    await inIsolatedSchema(async (client) => {
      await applyBase(client);
      await seedLegacyAuthority(client);
      await applyGateMigration(client);

      await client.query(`INSERT INTO outbox_events
        (tenant_id,id,business_task_id,event_id,event_type,payload)
        VALUES ('tenant_a','outbox_report','task_run','event_report','workflow.execute.requested','{}')`);
      await client.query(`INSERT INTO execution_attempts
        (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,worker_instance_id,
         status,fencing_token,lease_until)
        VALUES ('tenant_a','attempt_report','task_run',1,'event_report','gate0.2a-worker','gate0.2a-local',
          'worker-report','running',1,now()+interval '1 minute')`);
      await client.query(`UPDATE business_tasks SET current_execution_attempt_id='attempt_report',execution_version=1,
        execution_fencing_token=1,status='running' WHERE tenant_id='tenant_a' AND id='task_run'`);
      await client.query(`INSERT INTO attempt_output_candidates
        (tenant_id,id,business_task_id,execution_attempt_id,execution_version,fencing_token,worker_instance_id,
         payload,payload_sha256,idempotency_key)
        VALUES ('tenant_a','candidate_report','task_run','attempt_report',1,1,'worker-report','{}','${hashC}','candidate-report-1')`);
      await client.query(`INSERT INTO report_publish_intents
        (tenant_id,id,business_task_id,execution_attempt_id,candidate_id,source_document_snapshot_id,root_artifact_id,
         conversation_id,owner_user_id,resource_scope,data_class,audience,artifact_id,manifest_id,storage_bucket,
         storage_key,template_id,template_sha256,render_input_sha256,size_bytes,content_sha256,status)
        VALUES ('tenant_a','report_intent','task_run','attempt_report','candidate_report','snapshot_a','artifact_source',
          'conversation_a','user_a','artifact:artifact_source','C1','conversation:conversation_a','artifact_report',
          'manifest_report','bucket-a','report/key','gate0.2a-report/v1','${hashA}','${hashB}',256,'${hashC}','prepared')`);

      await expect(client.query(`UPDATE report_publish_intents
        SET status='published',state_version=2,etag_observed='etag'
        WHERE tenant_id='tenant_a' AND id='report_intent'`)).rejects.toThrow(/invalid report publish intent transition/u);

      await client.query(`UPDATE report_publish_intents
        SET status='object_verified',state_version=2,etag_observed='etag-report',updated_at=now()
        WHERE tenant_id='tenant_a' AND id='report_intent'`);
      await client.query(`INSERT INTO artifacts
        (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,content_sha256,
         business_task_id,root_artifact_id,data_class,audience,resource_scope)
        VALUES ('tenant_a','artifact_report','conversation_a','user_a','simulation_report','report.md','text/markdown',
          256,'${hashC}','task_run','artifact_source','C1',
          '{"kind":"private-conversation","conversationId":"conversation_a"}','artifact:artifact_source')`);
      await client.query(`INSERT INTO artifact_manifests
        (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,content_sha256,retention_policy)
        VALUES ('tenant_a','manifest_report','artifact_report','bucket-a','report/key','report.md','text/markdown',
          256,'${hashC}','gate0.2a-internal/v1')`);
      await client.query(`INSERT INTO artifact_states
        (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status,state_version)
        VALUES ('tenant_a','artifact_report','active','verified','active','2099-01-01T00:00:00Z','in_sync',1)`);
      await client.query(`UPDATE execution_attempts SET status='completed',completed_at=now()
        WHERE tenant_id='tenant_a' AND id='attempt_report'`);
      await client.query(`UPDATE business_tasks SET status='completed'
        WHERE tenant_id='tenant_a' AND id='task_run'`);
      await client.query(`UPDATE report_publish_intents
        SET status='published',state_version=3,updated_at=now()
        WHERE tenant_id='tenant_a' AND id='report_intent'`);

      const published = await client.query(`SELECT status,state_version,artifact_id,manifest_id
        FROM report_publish_intents WHERE tenant_id='tenant_a' AND id='report_intent'`);
      expect(published.rows[0]).toEqual({
        status: 'published', state_version: '3', artifact_id: 'artifact_report', manifest_id: 'manifest_report',
      });
      await expect(client.query(`UPDATE report_publish_intents SET storage_key='tampered',state_version=4
        WHERE tenant_id='tenant_a' AND id='report_intent'`)).rejects.toThrow(/identity is immutable/u);
    });
  });

  it('aborts rather than assigning an unknown legacy idempotency record to an arbitrary tenant user', async () => {
    await inIsolatedSchema(async (client) => {
      await applyBase(client);
      await client.query(`INSERT INTO tenants (id,name) VALUES ('tenant_a','Tenant A');
        INSERT INTO users (tenant_id,id,display_name) VALUES
          ('tenant_a','user_a','User A'),('tenant_a','user_b','User B');
        INSERT INTO idempotency_records (tenant_id,operation,idempotency_key,request_digest,response)
          VALUES ('tenant_a','unknown.operation','unknown-operation-key','d','{}')`);

      await expect(applyGateMigration(client)).rejects.toThrow(/cannot safely backfill principal_id/u);
      const principalColumn = await client.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='idempotency_records' AND column_name='principal_id'`);
      expect(principalColumn.rowCount).toBe(0);
    });
  });

  it('creates immutable, principal-bound query snapshots with a bounded TTL', async () => {
    await inIsolatedSchema(async (client) => {
      await applyBase(client);
      await client.query(`INSERT INTO tenants (id,name) VALUES ('tenant_a','Tenant A');
        INSERT INTO users (tenant_id,id,display_name) VALUES ('tenant_a','user_a','User A')`);
      await applyQuerySnapshotMigration(client);
      await client.query(`INSERT INTO query_snapshots
        (tenant_id,id,principal_id,query_kind,authorization_epoch,canonical_query,query_version,field_mask_version,as_of,expires_at)
        VALUES ('tenant_a','query_a','user_a','business_tasks',$1,'{}','business-tasks.list.v1',
          'business-tasks.list.public.v1',now(),now()+interval '15 minutes')`, [hashA]);
      await client.query(`INSERT INTO query_snapshot_items
        (tenant_id,query_snapshot_id,position,object_id,sort_key)
        VALUES ('tenant_a','query_a',0,'task_a','{"value":"2026-07-22T00:00:00.000Z","id":"task_a"}')`);

      await expect(client.query("UPDATE query_snapshots SET query_version='changed' WHERE tenant_id='tenant_a' AND id='query_a'"))
        .rejects.toThrow(/query snapshots are immutable/u);
      await expect(client.query("UPDATE query_snapshot_items SET object_id='task_b' WHERE tenant_id='tenant_a' AND query_snapshot_id='query_a' AND position=0"))
        .rejects.toThrow(/query snapshots are immutable/u);
      await expect(client.query(`INSERT INTO query_snapshots
        (tenant_id,id,principal_id,query_kind,authorization_epoch,canonical_query,query_version,field_mask_version,as_of,expires_at)
        VALUES ('tenant_a','query_too_long','user_a','business_tasks',$1,'{}','v1','mask-v1',now(),now()+interval '16 minutes')`, [hashA]))
        .rejects.toThrow(/query_snapshots_check/u);
    });
  });
});
