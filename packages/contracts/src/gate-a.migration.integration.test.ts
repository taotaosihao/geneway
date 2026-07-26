import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for Gate A migration integration tests');
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl });
const tenant = 'tenant_gate_a_migration';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const hashD = 'd'.repeat(64);
const hashE = 'e'.repeat(64);
const hashF = 'f'.repeat(64);
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const reportSourceBytes = Buffer.from('Gate A migration report source authority', 'utf8');
const reportSourceSha = sha256(reportSourceBytes);
const reportCanonicalSelectionProjection = {
  schemaVersion: 'canonical-selection-projection.gate-a/1',
  selectionPolicyVersion: 'canonical-complete-paragraph-concat/1',
  sourceExtractionVersion: 'canonical-text/plain-utf8/1',
  sourceCanonicalTextSha256: reportSourceSha,
  sourceCanonicalByteLength: reportSourceBytes.byteLength,
  sourceCanonicalPageIndexSha256: null,
  selectedParagraphs: [{
    sourceParagraphIndex: 0,
    startByte: 0,
    endByteExclusive: reportSourceBytes.byteLength,
    paragraphByteLength: reportSourceBytes.byteLength,
    paragraphBytesSha256: reportSourceSha,
    pageSegments: [],
  }],
  selectedTotalBytes: reportSourceBytes.byteLength,
  selectedModelInputSha256: reportSourceSha,
  truncated: false,
};
const reportResultBytes = Buffer.from('{"schemaVersion":"analysis-result/1","summary":"ok"}', 'utf8');
const reportResult = { schemaVersion: 'analysis-result/1', summary: 'ok' };
const reportResultSha = sha256(reportResultBytes);
const reportBytes = Buffer.from('# Gate A report\n\nVerified.\n', 'utf8');
const reportSha = sha256(reportBytes);
const legacyExcerpt = 'legacy fixture evidence';
const legacyExcerptSha = sha256(legacyExcerpt);
const parserManifest = {
  schemaVersion: 'parser-manifest.gate-a/1',
  id: 'parser-gate-a-migration',
  mediaType: 'text/plain',
  parser: {
    name: 'geneway-plain-text-parser',
    version: '1.0.0',
    registrySource: 'geneway-workspace',
    upstreamSource: 'geneway://packages/ingestion/plain-text-parser',
    lockResolution: 'workspace:packages/ingestion',
    lockIntegrity: hashA,
    executableDigest: hashA,
    packageDigest: hashB,
    license: 'UNLICENSED-internal',
  },
  dependencies: [],
  conversionConfig: {
    inputEncoding: 'UTF-8',
    outputEncoding: 'UTF-8',
    unicodeNormalization: 'none',
    newlineNormalization: 'none',
    stripByteOrderMark: false,
    maxInputBytes: 1_048_576,
    maxOutputBytes: 1_048_576,
  },
  resourceLimitsVersion: 'gate-a-parser-limits/1',
  approvedBy: 'user-gate-a-migration',
  approvedAt: '2026-07-26T00:00:00.000Z',
  expiresAt: '2027-07-26T00:00:00.000Z',
  manifestDigest: hashA,
};

const seedReportPublishAuthority = async (): Promise<void> => {
  const liveParserManifest = {
    ...parserManifest,
    id: 'parser-gate-a-report-finalization',
    manifestDigest: hashC,
  };
  const audience = { kind: 'private-conversation', conversationId: 'conversation-gate-a-migration' };
  await pool.query(`INSERT INTO workflow_template_versions
    (tenant_id,template_id,schema_version,capability_version_id,harness_version_id,
     workflow_draft_schema_version,workflow_payload_schema_version,compiler_version,
     canonicalization_version,registry_digest,canonical_entry)
    VALUES ($1,'workflow-template.solution-live/1','workflow-template-version/1',
      'cap-gate-a-migration','harness-gate-a-migration','workflow-draft.template-v1',
      'workflow-version.template-v1','geneway-workflow-compiler/0.2.0','RFC8785/JCS-1',$2,$3)
    ON CONFLICT (tenant_id,template_id) DO NOTHING`, [tenant, hashA, {
    templateId: 'workflow-template.solution-live/1', registryDigest: hashA,
  }]);
  await pool.query(`INSERT INTO workflow_versions
    (tenant_id,id,workflow_hash,canonicalization_version,canonical_json,
     record_variant,template_id,registry_digest)
    VALUES ($1,'workflow-live-report-finalization',$2,'RFC8785/JCS-1',
      '{"schemaVersion":"workflow-version.template-v1"}',
      'workflow-read-model.live/1','workflow-template.solution-live/1',$3)`,
  [tenant, hashC, hashA]);
  await pool.query(`INSERT INTO artifacts
    (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,
     content_sha256,root_artifact_id,data_class,audience,resource_scope)
    VALUES ($1,'source-report-finalization','conversation-gate-a-migration','user-gate-a-migration',
      'source_document','source.txt','text/plain',$2,$3,'source-report-finalization','C1',$4,
      'artifact:source-report-finalization')`, [tenant, reportSourceBytes.byteLength, reportSourceSha, audience]);
  await pool.query(`INSERT INTO artifact_manifests
    (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,
     content_sha256,retention_policy)
    VALUES ($1,'source-manifest-report-finalization','source-report-finalization','gate-a-test',
      'source-report-finalization.txt','source.txt','text/plain',$2,$3,'gate0.2a-internal/v1')`,
  [tenant, reportSourceBytes.byteLength, reportSourceSha]);
  await pool.query(`INSERT INTO artifact_states
    (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,
     reconcile_status,etag_observed,last_verified_at)
    VALUES ($1,'source-report-finalization','active','verified','active',now()+interval '1 hour',
      'in_sync','source-etag',now())`, [tenant]);
  await pool.query(`INSERT INTO document_snapshots
    (tenant_id,id,conversation_id,artifact_id,manifest_id,display_name,media_type,size_bytes,
     content_sha256,data_class,audience,resource_scope,trust,simulation_profile,
     profile_registry_version,created_by)
    VALUES ($1,'snapshot-report-finalization','conversation-gate-a-migration',
      'source-report-finalization','source-manifest-report-finalization','source.txt','text/plain',
      $2,$3,'C1',$4,'artifact:source-report-finalization','untrusted_text',NULL,
      'gate0.2a-profile-registry/1','user-gate-a-migration')`,
  [tenant, reportSourceBytes.byteLength, reportSourceSha, audience]);
  await pool.query(`INSERT INTO parser_manifests
    (tenant_id,id,schema_version,media_type,parser_name,parser_version,executable_digest,
     package_digest,manifest_digest,registry_source,upstream_source,lock_resolution,
     lock_integrity,license,dependencies,conversion_config,canonical_manifest,
     approved_by,approved_at,expires_at)
    VALUES ($1,$2,'parser-manifest.gate-a/1','text/plain','geneway-plain-text-parser','1.0.0',
      $3,$4,$5,'geneway-workspace','geneway://packages/ingestion/plain-text-parser',
      'workspace:packages/ingestion',$3,'UNLICENSED-internal','[]',$6,$7,
      'user-gate-a-migration','2026-07-26T00:00:00.000Z','2027-07-26T00:00:00.000Z')`, [
    tenant, liveParserManifest.id, hashA, hashB, hashC,
    liveParserManifest.conversionConfig, liveParserManifest,
  ]);
  await pool.query(`INSERT INTO document_snapshot_canonical_representations
    (tenant_id,document_snapshot_id,parser_manifest_id,parser_digest,extraction_version,
     canonical_bytes,canonical_text_sha256,canonical_page_index,canonical_page_index_sha256,
     resource_limits_version)
    VALUES ($1,'snapshot-report-finalization',$2,$3,'canonical-text/plain-utf8/1',$4,$5,
      NULL,NULL,'gate-a-parser-limits/1')`,
  [tenant, liveParserManifest.id, hashC, reportSourceBytes, reportSourceSha]);
  const inputSnapshot = {
    kind: 'live_document_snapshot',
    recordVariant: 'business-task-input.live-material/1',
    dataClass: 'C1',
    trust: 'untrusted_text',
    resourceScope: 'artifact:source-report-finalization',
    documentSnapshotId: 'snapshot-report-finalization',
    artifactId: 'source-report-finalization',
    artifactSha256: reportSourceSha,
    parserManifestId: liveParserManifest.id,
    parserDigest: hashC,
    extractionVersion: 'canonical-text/plain-utf8/1',
    canonicalTextSha256: reportSourceSha,
  };
  await pool.query(`INSERT INTO business_tasks
    (tenant_id,id,conversation_id,capability_version_id,expert_catalog_version_id,harness_version_id,
     workflow_version_id,workflow_hash,requester_id,status,input_snapshot,expert_target,
     permission_scope,audience_scope,budget,simulation,runtime_mode,business_decision_allowed,
     record_variant,result_record_variant,semantic_fingerprint,result)
    VALUES ($1,'task-report-finalization','conversation-gate-a-migration','cap-gate-a-migration',
      'experts-gate-a-migration','harness-gate-a-migration','workflow-live-report-finalization',$2,
      'user-gate-a-migration','running',$3,'{}','{}','{}','{}',false,'model_gateway',false,
      'business-task.live/1',NULL,$4,NULL)`,
  [tenant, hashC, inputSnapshot, hashD]);
  await pool.query(`INSERT INTO business_task_steps
    (tenant_id,business_task_id,step_id,status,attempt_id,fencing_token,simulation,runtime_mode,
     business_decision_allowed,record_variant)
    VALUES
      ($1,'task-report-finalization','solution_design','completed','solution-attempt-report-finalization',
       3,false,'model_gateway',false,'business-task-step.live/1'),
      ($1,'task-report-finalization','report_publish','running','report-attempt-report-finalization',
       1,false,'model_gateway',false,'business-task-step.live/1')`, [tenant]);
  await pool.query(`INSERT INTO outbox_events
    (tenant_id,id,business_task_id,event_id,event_type,payload)
    VALUES ($1,'outbox-report-finalization','task-report-finalization',
      'event-report-finalization','gate_a.analysis.requested','{}')`, [tenant]);
  await pool.query(`INSERT INTO execution_attempts
    (tenant_id,id,business_task_id,execution_version,source_event_id,consumer,deployment_id,
     worker_instance_id,status,fencing_token,lease_until,completed_at)
    VALUES ($1,'execution-report-finalization','task-report-finalization',1,
      'event-report-finalization','gate0.2a-worker','gate0.2a-local','worker-report-finalization',
      'running',7,now()+interval '1 hour',NULL)`, [tenant]);
  await pool.query(`UPDATE business_tasks
    SET current_execution_attempt_id='execution-report-finalization',execution_version=1,
        execution_fencing_token=7
    WHERE tenant_id=$1 AND id='task-report-finalization'`, [tenant]);
  await pool.query(`INSERT INTO gate_a_model_invocations
    (tenant_id,id,business_task_id,workflow_version_id,workflow_hash,step_id,
     execution_attempt_id,step_attempt_id,task_fence,step_fence,approval_subject_digest,
     capability_version_id,prompt_policy_version_id,expert_target_digest,parser_manifest_id,
     document_snapshot_id,canonical_text_sha256,logical_model_policy,route_profile,data_class,
     status,output_payload_digest,provider_revision,model_revision,usage,deadline,terminal_at,
     artifact_id,artifact_sha256,canonical_page_index_sha256,parser_digest,extraction_version,
     resource_scope,canonical_selection_projection,canonical_selection_projection_digest,
     selected_model_input_sha256,
     material_projection_digest,prompt_policy_resolved_bytes_sha256,
     provider_input_projection_digest,tool_choice,output_schema_version,max_input_bytes,
     max_output_tokens,gateway_receipt_jti,gateway_receipt_digest,gateway_receipt_signature,
     receipt_attested,prior_step_outputs_digest,evidence_candidate_projection,agent_registry_reference)
    VALUES ($1,'invocation-report-finalization','task-report-finalization',
      'workflow-live-report-finalization',$2,'solution_design','execution-report-finalization',
      'solution-attempt-report-finalization',7,3,$3,'cap-gate-a-migration','prompt-report-finalization',
      $4,'parser-gate-a-report-finalization','snapshot-report-finalization',$6,
      'business.solution.analysis.standard',
      'codex_subscription_dev','C1','completed',$7,'provider-test/1','model-test/1',
      '{"inputTokens":1,"outputTokens":1,"totalTokens":2}',
      now()+interval '1 hour',now(),'source-report-finalization',$6,NULL,$5,
      'canonical-text/plain-utf8/1','artifact:source-report-finalization',$9,$4,$6,$4,$4,$4,'none',
      'analysis.result-candidate/1',1048576,4096,'00000000-0000-4000-8000-000000000001',$4,$8,true,$4,'[{}]'::jsonb,
      'agent.solution.architect/live-1')`, [
    tenant, hashC, hashE, hashF, hashC, reportSourceSha, reportResultSha, 'A'.repeat(43),
    reportCanonicalSelectionProjection,
  ]);
  await pool.query(`INSERT INTO gate_a_live_results
    (tenant_id,business_task_id,record_variant,model_invocation_id,schema_version,result,
     result_sha256,canonical_result_bytes)
    VALUES ($1,'task-report-finalization','business-task-result.live/1',
      'invocation-report-finalization','analysis-result/1',$2,$3,$4)`,
  [tenant, reportResult, reportResultSha, reportResultBytes]);
  await pool.query(`INSERT INTO business_task_events
    (tenant_id,id,business_task_id,sequence,event_type,schema_version,aggregate_version,correlation_id,payload,
     simulation,runtime_mode,business_decision_allowed,record_variant)
    VALUES ($1,'event-live-report-finalization','task-report-finalization',1,'live.analysis.staged',2,1,
      'task-report-finalization','{}',false,'model_gateway',false,'business-task-event.live/1')`, [tenant]);
  await pool.query(`INSERT INTO gate_a_live_evidence
    (tenant_id,id,business_task_id,record_variant,document_snapshot_id,locator,excerpt_bytes,
     excerpt_sha256,resource_scope,data_class,audience,accessible,publication_state)
    VALUES ($1,'evidence-live-report-finalization','task-report-finalization','evidence.live/1',
      'snapshot-report-finalization',$2,$3,$4,'artifact:source-report-finalization','C1',
      'conversation:conversation-gate-a-migration',false,'staging')`, [tenant, {
    schemaVersion: 'evidence-locator.live/1', kind: 'canonical_text_span',
    sourceArtifactId: 'source-report-finalization', sourceArtifactSha256: reportSourceSha,
    documentSnapshotId: 'snapshot-report-finalization', canonicalTextSha256: reportSourceSha,
    parserManifestId: liveParserManifest.id, parserDigest: hashC,
    extractionVersion: 'canonical-text/plain-utf8/1', excerptSha256: reportSourceSha,
    excerptByteLength: reportSourceBytes.byteLength, startByte: 0, endByteExclusive: reportSourceBytes.byteLength,
  }, reportSourceBytes, reportSourceSha]);
  await pool.query(`INSERT INTO gate_a_live_claims
    (tenant_id,id,business_task_id,record_variant,statement_id,statement_kind,text,confidence,status,publication_state)
    VALUES ($1,'claim-live-report-finalization','task-report-finalization','claim.live/1','fact_live_1',
      'fact','live fact',1,'published','staging')`, [tenant]);
  await pool.query(`INSERT INTO gate_a_live_evidence_links
    (tenant_id,id,business_task_id,claim_id,evidence_id,relation,publication_state)
    VALUES ($1,'link-live-report-finalization','task-report-finalization','claim-live-report-finalization',
      'evidence-live-report-finalization','supports','staging')`, [tenant]);
  await pool.query(`INSERT INTO artifacts
    (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,
     content_sha256,business_task_id,root_artifact_id,data_class,audience,resource_scope,record_variant)
    VALUES ($1,'artifact-report-finalization','conversation-gate-a-migration','user-gate-a-migration',
      'analysis_report','report.md','text/markdown',$2,$3,'task-report-finalization',
      'source-report-finalization','C1',$4,'artifact:source-report-finalization',
      'artifact.analysis-report.live/1')`, [tenant, reportBytes.byteLength, reportSha, audience]);
  await pool.query(`INSERT INTO artifact_manifests
    (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,
     content_sha256,retention_policy)
    VALUES ($1,'manifest-report-finalization','artifact-report-finalization','gate-a-test',
      'reports/report-finalization.md','report.md','text/markdown',$2,$3,'gate0.2a-internal/v1')`,
  [tenant, reportBytes.byteLength, reportSha]);
  await pool.query(`INSERT INTO artifact_states
    (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,
     reconcile_status,etag_observed,last_verified_at)
    VALUES ($1,'artifact-report-finalization','active','verified','active',now()+interval '1 hour',
      'in_sync','report-etag',now())`, [tenant]);
  await pool.query(`INSERT INTO gate_a_live_reports
    (tenant_id,artifact_id,business_task_id,record_variant,result_sha256,workflow_version_id,
     workflow_hash,model_invocation_id,renderer_version,internal_acceptance)
    VALUES ($1,'artifact-report-finalization','task-report-finalization',
      'artifact.analysis-report.live/1',$2,'workflow-live-report-finalization',$3,
      'invocation-report-finalization','analysis-report-renderer/1',true)`,
  [tenant, reportResultSha, hashC]);
  await pool.query(`INSERT INTO artifacts
    (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,
     content_sha256,business_task_id,root_artifact_id,data_class,audience,resource_scope)
    VALUES ($1,'artifact-legacy-report','conversation-gate-a-migration','user-gate-a-migration',
      'simulation_report','legacy-report.md','text/markdown',$2,$3,'task-legacy-gate-a-migration',
      'source-report-finalization','C1',$4,'artifact:source-report-finalization')`, [
    tenant, reportBytes.byteLength, reportSha, audience,
  ]);
  await pool.query(`INSERT INTO artifact_manifests
    (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,
     content_sha256,retention_policy)
    VALUES ($1,'manifest-legacy-report','artifact-legacy-report','gate-a-test','reports/legacy-report.md',
      'legacy-report.md','text/markdown',$2,$3,'gate0.2a-internal/v1')`, [tenant, reportBytes.byteLength, reportSha]);
  await pool.query(`INSERT INTO artifact_states
    (tenant_id,artifact_id,availability,integrity,retention_status,retention_expires_at,reconcile_status)
    VALUES ($1,'artifact-legacy-report','active','verified','active',now()+interval '1 hour','in_sync')`, [tenant]);
  await pool.query(`INSERT INTO gate_a_live_report_publish_intents
    (tenant_id,id,business_task_id,result_sha256,workflow_version_id,workflow_hash,
     approval_subject_digest,model_invocation_id,execution_attempt_id,task_fence,step_fence,
     document_snapshot_id,source_artifact_id,source_artifact_sha256,canonical_text_sha256,
     parser_manifest_id,parser_digest,extraction_version,root_artifact_id,conversation_id,
     owner_user_id,resource_scope,data_class,audience,artifact_id,manifest_id,storage_bucket,
     storage_key,renderer_version,render_input_sha256,size_bytes,content_sha256,status,state_version)
    VALUES ($1,'intent-report-finalization','task-report-finalization',$2,
      'workflow-live-report-finalization',$3,$4,'invocation-report-finalization',
      'execution-report-finalization',7,3,'snapshot-report-finalization','source-report-finalization',
      $5,$5,'parser-gate-a-report-finalization',$6,'canonical-text/plain-utf8/1',
      'source-report-finalization','conversation-gate-a-migration','user-gate-a-migration',
      'artifact:source-report-finalization','C1','conversation:conversation-gate-a-migration',
      'artifact-report-finalization','manifest-report-finalization','gate-a-test',
      'reports/report-finalization.md','analysis-report-renderer/1',$7,$8,$9,'prepared',1)`, [
    tenant, reportResultSha, hashC, hashE, reportSourceSha, hashC, hashF,
    reportBytes.byteLength, reportSha,
  ]);
  await pool.query(`UPDATE gate_a_live_report_publish_intents
    SET status='object_verified',state_version=2,etag_observed='report-etag'
    WHERE tenant_id=$1 AND id='intent-report-finalization'`, [tenant]);
};

const stageExactTerminalPublication = async (client: pg.PoolClient): Promise<void> => {
  await client.query(`UPDATE gate_a_live_results SET publication_state='published'
    WHERE tenant_id=$1 AND business_task_id='task-report-finalization'`, [tenant]);
  await client.query(`UPDATE gate_a_live_evidence SET publication_state='published',accessible=true
    WHERE tenant_id=$1 AND business_task_id='task-report-finalization'`, [tenant]);
  await client.query(`UPDATE gate_a_live_evidence_links SET publication_state='published'
    WHERE tenant_id=$1 AND business_task_id='task-report-finalization'`, [tenant]);
  await client.query(`UPDATE gate_a_live_claims SET publication_state='published'
    WHERE tenant_id=$1 AND business_task_id='task-report-finalization'`, [tenant]);
  await client.query(`UPDATE execution_attempts SET status='completed',completed_at=now()
    WHERE tenant_id=$1 AND id='execution-report-finalization'`, [tenant]);
  await client.query(`UPDATE business_task_steps SET status='completed'
    WHERE tenant_id=$1 AND business_task_id='task-report-finalization' AND step_id='report_publish'`, [tenant]);
  await client.query(`UPDATE gate_a_live_report_publish_intents
    SET status='published',state_version=3,published_at=now()
    WHERE tenant_id=$1 AND id='intent-report-finalization'`, [tenant]);
  await client.query(`UPDATE business_tasks
    SET status='completed',result_record_variant='business-task-result.live/1',result=$2
    WHERE tenant_id=$1 AND id='task-report-finalization'`, [tenant, reportResult]);
};

beforeAll(async () => {
  await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'Gate A migration test')", [tenant]);
  await pool.query(`INSERT INTO users(tenant_id,id,display_name)
    VALUES ($1,'user-gate-a-migration','Gate A migration user')`, [tenant]);
  await pool.query(`INSERT INTO conversations(tenant_id,id,user_id)
    VALUES ($1,'conversation-gate-a-migration','user-gate-a-migration')`, [tenant]);
  await pool.query(`INSERT INTO capability_versions(tenant_id,id,capability_id,version,spec)
    VALUES ($1,'cap-gate-a-migration','solution.analysis.v1',9001,'{}')`, [tenant]);
  await pool.query(`INSERT INTO expert_catalog_versions(tenant_id,id,version,catalog)
    VALUES ($1,'experts-gate-a-migration',9001,'{}')`, [tenant]);
  await pool.query(`INSERT INTO harness_versions(tenant_id,id,capability_version_id,version,spec)
    VALUES ($1,'harness-gate-a-migration','cap-gate-a-migration',9001,'{}')`, [tenant]);
  await pool.query(`INSERT INTO workflow_versions
    (tenant_id,id,workflow_hash,canonicalization_version,canonical_json)
    VALUES ($1,'workflow-legacy-gate-a-migration',$2,'RFC8785/JCS-1','{}')`, [tenant, hashA]);
  await pool.query(`INSERT INTO business_tasks
    (tenant_id,id,conversation_id,capability_version_id,expert_catalog_version_id,harness_version_id,
     workflow_version_id,workflow_hash,requester_id,status,input_snapshot,expert_target,permission_scope,
     audience_scope,budget,simulation,runtime_mode,business_decision_allowed)
    VALUES ($1,'task-legacy-gate-a-migration','conversation-gate-a-migration','cap-gate-a-migration',
     'experts-gate-a-migration','harness-gate-a-migration','workflow-legacy-gate-a-migration',$2,
     'user-gate-a-migration','completed','{"kind":"fixture"}','{}','{}','{}','{}',true,'fake',false)`,
  [tenant, hashA]);
  await pool.query(`UPDATE business_tasks SET result='{"summary":"legacy"}'::jsonb
    WHERE tenant_id=$1 AND id='task-legacy-gate-a-migration'`, [tenant]);
  await pool.query(`INSERT INTO business_task_steps
    (tenant_id,business_task_id,step_id,status,simulation,runtime_mode,business_decision_allowed)
    VALUES ($1,'task-legacy-gate-a-migration','legacy_step','completed',true,'fake',false)`, [tenant]);
  await pool.query(`INSERT INTO business_task_events
    (tenant_id,id,business_task_id,sequence,event_type,schema_version,aggregate_version,correlation_id,payload,
     simulation,runtime_mode,business_decision_allowed)
    VALUES ($1,'event-legacy-gate-a-migration','task-legacy-gate-a-migration',1,'legacy.completed',1,1,
      'task-legacy-gate-a-migration','{}',true,'fake',false)`, [tenant]);
  await pool.query(`INSERT INTO claims
    (tenant_id,id,business_task_id,text,status,rejection_code,resource_scope,data_class,audience,
     simulation,runtime_mode,business_decision_allowed)
    VALUES ($1,'claim-legacy-gate-a-migration','task-legacy-gate-a-migration','legacy claim','rejected','LEGACY_FIXTURE',
      'fixture:solution-analysis:v1','C1','conversation:conversation-gate-a-migration',true,'fake',false)`, [tenant]);
  await pool.query(`INSERT INTO evidence_items
    (tenant_id,id,business_task_id,source_kind,source,source_excerpt,excerpt_sha256,resource_scope,data_class,
     audience,accessible,simulation,runtime_mode,business_decision_allowed)
    VALUES ($1,'evidence-legacy-gate-a-migration','task-legacy-gate-a-migration','legacy_fixture',$2,$3,$4,
      'fixture:solution-analysis:v1','C1','conversation:conversation-gate-a-migration',true,true,'fake',false)`, [
    tenant, { kind: 'legacy_fixture', fixtureRef: 'fixture:solution-analysis:v1', fixtureVersion: '1',
      sourceId: 'legacy-source', excerptSha256: legacyExcerptSha }, legacyExcerpt, legacyExcerptSha,
  ]);
  await pool.query(`INSERT INTO evidence_links
    (tenant_id,id,business_task_id,claim_id,evidence_id,relation)
    VALUES ($1,'link-legacy-gate-a-migration','task-legacy-gate-a-migration',
      'claim-legacy-gate-a-migration','evidence-legacy-gate-a-migration','supports')`, [tenant]);
  await seedReportPublishAuthority();
});

afterAll(async () => {
  await pool.end();
});

describe('Gate A migration fail-closed authority', () => {
  it('preserves legacy text rows while admitting PDF and DOCX through every source-artifact relation', async () => {
    const client = await pool.connect();
    const formats = [
      { extension: 'pdf', mediaType: 'application/pdf' },
      {
        extension: 'docx',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ] as const;
    try {
      await client.query('BEGIN');
      for (const format of formats) {
        const suffix = format.extension;
        const artifactId = `artifact-gate-a-format-${suffix}`;
        const manifestId = `manifest-gate-a-format-${suffix}`;
        const snapshotId = `snapshot-gate-a-format-${suffix}`;
        const contentSha = sha256(`Gate A ${suffix} source bytes`);
        const audience = { kind: 'private-conversation', conversationId: 'conversation-gate-a-migration' };
        await client.query(`INSERT INTO artifact_ingest_intents
          (tenant_id,id,conversation_id,requester_id,idempotency_key,request_digest,status,
           artifact_id,manifest_id,document_snapshot_id,storage_bucket,storage_key,display_name,
           media_type,size_bytes,content_sha256,extension,simulation_profile,profile_registry_version,ingest_mode)
          VALUES ($1,$2,'conversation-gate-a-migration','user-gate-a-migration',$3,$4,'intent_created',
            $5,$6,$7,'gate-a-test',$8,$9,$10,64,$11,$12,NULL,'gate0.2a-profile-registry/1','live_canonical')`, [
          tenant, `intent-gate-a-format-${suffix}`, `idempotency-gate-a-format-${suffix}`, hashA,
          artifactId, manifestId, snapshotId, `sources/${artifactId}.${suffix}`,
          `source.${suffix}`, format.mediaType, contentSha, format.extension,
        ]);
        await client.query(`INSERT INTO artifacts
          (tenant_id,id,conversation_id,owner_user_id,kind,display_name,media_type,size_bytes,
           content_sha256,data_class,audience,resource_scope)
          VALUES ($1,$2,'conversation-gate-a-migration','user-gate-a-migration','source_document',
            $3,$4,64,$5,'C1',$6,$7)`, [
          tenant, artifactId, `source.${suffix}`, format.mediaType, contentSha, audience, `artifact:${artifactId}`,
        ]);
        await client.query(`INSERT INTO artifact_manifests
          (tenant_id,id,artifact_id,storage_bucket,storage_key,display_name,media_type,size_bytes,
           content_sha256,retention_policy)
          VALUES ($1,$2,$3,'gate-a-test',$4,$5,$6,64,$7,'gate0.2a-internal/v1')`, [
          tenant, manifestId, artifactId, `sources/${artifactId}.${suffix}`,
          `source.${suffix}`, format.mediaType, contentSha,
        ]);
        await client.query(`INSERT INTO document_snapshots
          (tenant_id,id,conversation_id,artifact_id,manifest_id,display_name,media_type,size_bytes,
           content_sha256,data_class,audience,resource_scope,trust,simulation_profile,
           profile_registry_version,created_by)
          VALUES ($1,$2,'conversation-gate-a-migration',$3,$4,$5,$6,64,$7,'C1',$8,$9,
            'untrusted_text',NULL,'gate0.2a-profile-registry/1','user-gate-a-migration')`, [
          tenant, snapshotId, artifactId, manifestId, `source.${suffix}`, format.mediaType,
          contentSha, audience, `artifact:${artifactId}`,
        ]);
      }
      const inserted = await client.query<{ count: number }>(`SELECT count(*)::int count
        FROM document_snapshots WHERE tenant_id=$1 AND id LIKE 'snapshot-gate-a-format-%'`, [tenant]);
      expect(inserted.rows).toEqual([{ count: 2 }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('reads legacy and live relation selectors independently without cross-selection or cursor reuse', async () => {
    const selectors = await pool.query<{
      legacy_task_variant: string | null; legacy_simulation: boolean; legacy_runtime: string;
      live_task_variant: string | null; live_simulation: boolean; live_runtime: string;
      legacy_step_variant: string | null; live_step_variant: string | null;
      legacy_event_variant: string | null; legacy_event_schema: number; live_event_count: number;
      legacy_result_present: boolean; live_result_variant: string; legacy_claims: number;
      legacy_evidence: number; live_claims: number; live_evidence: number; legacy_reports: number;
      live_reports: number; legacy_workflow_variant: string | null;
      live_workflow_variant: string | null; cross_live_on_legacy: number; cross_legacy_on_live: number;
      live_claim_variant: string; live_evidence_variant: string; live_report_variant: string;
      legacy_report_variant: string | null; live_link_count: number; legacy_link_count: number;
    }>(`SELECT
      (SELECT record_variant FROM business_tasks WHERE id='task-legacy-gate-a-migration') legacy_task_variant,
      (SELECT simulation FROM business_tasks WHERE id='task-legacy-gate-a-migration') legacy_simulation,
      (SELECT runtime_mode FROM business_tasks WHERE id='task-legacy-gate-a-migration') legacy_runtime,
      (SELECT record_variant FROM business_tasks WHERE id='task-report-finalization') live_task_variant,
      (SELECT simulation FROM business_tasks WHERE id='task-report-finalization') live_simulation,
      (SELECT runtime_mode FROM business_tasks WHERE id='task-report-finalization') live_runtime,
      (SELECT record_variant FROM business_task_steps WHERE business_task_id='task-legacy-gate-a-migration') legacy_step_variant,
      (SELECT record_variant FROM business_task_steps WHERE business_task_id='task-report-finalization' ORDER BY step_id LIMIT 1) live_step_variant,
      (SELECT record_variant FROM business_task_events WHERE business_task_id='task-legacy-gate-a-migration') legacy_event_variant,
      (SELECT schema_version FROM business_task_events WHERE business_task_id='task-legacy-gate-a-migration') legacy_event_schema,
      (SELECT count(*)::int FROM business_task_events WHERE business_task_id='task-report-finalization') live_event_count,
      (SELECT result IS NOT NULL FROM business_tasks WHERE id='task-legacy-gate-a-migration') legacy_result_present,
      (SELECT record_variant FROM gate_a_live_results WHERE business_task_id='task-report-finalization') live_result_variant,
      (SELECT count(*)::int FROM claims WHERE business_task_id='task-legacy-gate-a-migration') legacy_claims,
      (SELECT count(*)::int FROM evidence_items WHERE business_task_id='task-legacy-gate-a-migration') legacy_evidence,
      (SELECT count(*)::int FROM gate_a_live_claims WHERE business_task_id='task-report-finalization') live_claims,
      (SELECT count(*)::int FROM gate_a_live_evidence WHERE business_task_id='task-report-finalization') live_evidence,
      (SELECT count(*)::int FROM artifacts WHERE business_task_id='task-legacy-gate-a-migration'
        AND kind='simulation_report' AND record_variant IS NULL) legacy_reports,
      (SELECT count(*)::int FROM gate_a_live_reports WHERE business_task_id='task-report-finalization') live_reports,
      (SELECT record_variant FROM gate_a_live_claims WHERE business_task_id='task-report-finalization') live_claim_variant,
      (SELECT record_variant FROM gate_a_live_evidence WHERE business_task_id='task-report-finalization') live_evidence_variant,
      (SELECT record_variant FROM gate_a_live_reports WHERE business_task_id='task-report-finalization') live_report_variant,
      (SELECT record_variant FROM artifacts WHERE id='artifact-legacy-report') legacy_report_variant,
      (SELECT count(*)::int FROM gate_a_live_evidence_links WHERE business_task_id='task-report-finalization') live_link_count,
      (SELECT count(*)::int FROM evidence_links WHERE business_task_id='task-legacy-gate-a-migration') legacy_link_count,
      (SELECT record_variant FROM workflow_versions WHERE id='workflow-legacy-gate-a-migration') legacy_workflow_variant,
      (SELECT record_variant FROM workflow_versions WHERE id='workflow-live-report-finalization') live_workflow_variant,
      (SELECT count(*)::int FROM gate_a_live_results WHERE business_task_id='task-legacy-gate-a-migration') cross_live_on_legacy,
      (SELECT count(*)::int FROM claims WHERE business_task_id='task-report-finalization') cross_legacy_on_live`);
    expect(selectors.rows[0]).toEqual({ legacy_task_variant: null, legacy_simulation: true, legacy_runtime: 'fake',
      live_task_variant: 'business-task.live/1', live_simulation: false, live_runtime: 'model_gateway',
      legacy_step_variant: null, live_step_variant: 'business-task-step.live/1', legacy_event_variant: null,
      legacy_event_schema: 1, live_event_count: 1, legacy_result_present: true,
      live_result_variant: 'business-task-result.live/1', legacy_claims: 1, legacy_evidence: 1,
      live_claims: 1, live_evidence: 1, legacy_reports: 1, live_reports: 1,
      live_claim_variant: 'claim.live/1', live_evidence_variant: 'evidence.live/1',
      live_report_variant: 'artifact.analysis-report.live/1', legacy_report_variant: null,
      live_link_count: 1, legacy_link_count: 1,
      legacy_workflow_variant: null, live_workflow_variant: 'workflow-read-model.live/1',
      cross_live_on_legacy: 0, cross_legacy_on_live: 0 });
    const cursors = await pool.query<{ cursor: string }>(`SELECT cursor::text FROM business_task_events
      WHERE business_task_id IN ('task-legacy-gate-a-migration','task-report-finalization') ORDER BY cursor`);
    expect(new Set(cursors.rows.map((row) => row.cursor)).size).toBe(cursors.rowCount);
  });

  it('rejects a live selector relation attached to a legacy task', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO business_task_steps
          (tenant_id,business_task_id,step_id,status,simulation,runtime_mode,
           business_decision_allowed,record_variant)
        VALUES ($1,'task-legacy-gate-a-migration','mixed-live-step','queued',
          false,'model_gateway',false,'business-task-step.live/1')
      `, [tenant]);
      await expect(client.query('SET CONSTRAINTS business_task_steps_gate_a_variant_guard IMMEDIATE'))
        .rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a workflow whose registry digest is not the selected template digest', async () => {
    await pool.query(`
      INSERT INTO workflow_template_versions
        (tenant_id,template_id,schema_version,capability_version_id,harness_version_id,
         workflow_draft_schema_version,workflow_payload_schema_version,compiler_version,
         canonicalization_version,registry_digest,canonical_entry)
      VALUES ($1,'workflow-template.solution-live/1','workflow-template-version/1',
        'cap-gate-a-migration','harness-gate-a-migration','workflow-draft.template-v1',
        'workflow-version.template-v1','geneway-workflow-compiler/0.2.0','RFC8785/JCS-1',$2,$3)
      ON CONFLICT (tenant_id,template_id) DO NOTHING
    `, [tenant, hashA, {
      templateId: 'workflow-template.solution-live/1',
      registryDigest: hashA,
    }]);
    await expect(pool.query(`
      INSERT INTO workflow_versions
        (tenant_id,id,workflow_hash,canonicalization_version,canonical_json,
         record_variant,template_id,registry_digest)
      VALUES ($1,'workflow-live-bad-registry',$2,'RFC8785/JCS-1',
        '{"schemaVersion":"workflow-version.template-v1"}',
        'workflow-read-model.live/1','workflow-template.solution-live/1',$3)
    `, [tenant, hashB, hashB])).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects ParserManifest mirror tampering and protects accepted authority from mutation', async () => {
    const mismatched = {
      ...parserManifest,
      parser: { ...parserManifest.parser, executableDigest: hashB },
    };
    await expect(pool.query(`
      INSERT INTO parser_manifests
        (tenant_id,id,schema_version,media_type,parser_name,parser_version,executable_digest,
         package_digest,manifest_digest,registry_source,upstream_source,lock_resolution,
         lock_integrity,license,dependencies,conversion_config,canonical_manifest,
         approved_by,approved_at,expires_at)
      VALUES ($1,$2,'parser-manifest.gate-a/1','text/plain','geneway-plain-text-parser','1.0.0',
        $3,$4,$5,'geneway-workspace','geneway://packages/ingestion/plain-text-parser',
        'workspace:packages/ingestion',$3,'UNLICENSED-internal','[]',$6,$7,
        'user-gate-a-migration','2026-07-26T00:00:00.000Z','2027-07-26T00:00:00.000Z')
    `, [tenant, parserManifest.id, hashA, hashB, hashA, parserManifest.conversionConfig, mismatched]))
      .rejects.toMatchObject({ code: 'P0001' });

    await pool.query(`
      INSERT INTO parser_manifests
        (tenant_id,id,schema_version,media_type,parser_name,parser_version,executable_digest,
         package_digest,manifest_digest,registry_source,upstream_source,lock_resolution,
         lock_integrity,license,dependencies,conversion_config,canonical_manifest,
         approved_by,approved_at,expires_at)
      VALUES ($1,$2,'parser-manifest.gate-a/1','text/plain','geneway-plain-text-parser','1.0.0',
        $3,$4,$5,'geneway-workspace','geneway://packages/ingestion/plain-text-parser',
        'workspace:packages/ingestion',$3,'UNLICENSED-internal','[]',$6,$7,
        'user-gate-a-migration','2026-07-26T00:00:00.000Z','2027-07-26T00:00:00.000Z')
    `, [tenant, parserManifest.id, hashA, hashB, hashA, parserManifest.conversionConfig, parserManifest]);
    await expect(pool.query(
      'UPDATE parser_manifests SET package_digest=$1 WHERE tenant_id=$2 AND id=$3',
      [hashA, tenant, parserManifest.id],
    )).rejects.toMatchObject({ code: 'P0001' });
  });

  it('protects the selected immutable workflow template authority', async () => {
    await expect(pool.query(`
      UPDATE workflow_template_versions SET compiler_version='tampered'
      WHERE tenant_id=$1 AND template_id='workflow-template.solution-live/1'
    `, [tenant])).rejects.toMatchObject({ code: 'P0001' });
  });

  it('protects the model invocation canonical selection projection and digest from mutation', async () => {
    await expect(pool.query(`UPDATE gate_a_model_invocations
      SET canonical_selection_projection=jsonb_set(
        canonical_selection_projection,'{selectedModelInputSha256}',to_jsonb($1::text))
      WHERE tenant_id=$2 AND id='invocation-report-finalization'`, [hashA, tenant]))
      .rejects.toMatchObject({ code: 'P0001' });
    await expect(pool.query(`UPDATE gate_a_model_invocations
      SET canonical_selection_projection_digest=$1
      WHERE tenant_id=$2 AND id='invocation-report-finalization'`, [hashA, tenant]))
      .rejects.toMatchObject({ code: 'P0001' });
    await expect(pool.query(`UPDATE gate_a_model_invocations
      SET selected_model_input_sha256=$1
      WHERE tenant_id=$2 AND id='invocation-report-finalization'`, [hashA, tenant]))
      .rejects.toMatchObject({ code: 'P0001' });
  });

  it('rejects a report publish intent that bypasses the prepared version-1 authority', async () => {
    await expect(pool.query(`
      INSERT INTO gate_a_live_report_publish_intents (
        tenant_id,id,business_task_id,result_sha256,workflow_version_id,workflow_hash,
        approval_subject_digest,model_invocation_id,execution_attempt_id,task_fence,step_fence,
        document_snapshot_id,source_artifact_id,source_artifact_sha256,canonical_text_sha256,
        parser_manifest_id,parser_digest,extraction_version,root_artifact_id,conversation_id,
        owner_user_id,resource_scope,data_class,audience,artifact_id,manifest_id,storage_bucket,
        storage_key,renderer_version,render_input_sha256,size_bytes,content_sha256,status,
        state_version,etag_observed,failure_code,object_verified_at,published_at
      ) VALUES (
        $1,'report-intent-invalid-initial','task-missing',$2,'workflow-missing',$2,$2,
        'invocation-missing','execution-missing',1,1,'snapshot-missing','source-missing',$2,$2,
        'parser-missing',$2,'canonical-text/plain-utf8/1','source-missing','conversation-missing',
        'user-missing','artifact:source-missing','C1','conversation:conversation-missing',
        'report-artifact-missing','report-manifest-missing','bucket',
        'tenants/test/reports/report.md','analysis-report-renderer/1',$2,10,$2,
        'object_verified',1,'etag',NULL,now(),NULL
      )
    `, [tenant, hashA])).rejects.toMatchObject({ code: 'P0001' });
  });

  it.each(['canceled', 'failed'])('rejects published authority when the live task is %s', async (status) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await stageExactTerminalPublication(client);
      await client.query(`UPDATE business_tasks SET status=$2
        WHERE tenant_id=$1 AND id='task-report-finalization'`, [tenant, status]);
      await expect(client.query(
        'SET CONSTRAINTS gate_a_live_report_published_authority_guard IMMEDIATE',
      )).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects published authority when the live report_publish step is still queued', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await stageExactTerminalPublication(client);
      await client.query(`UPDATE business_task_steps SET status='queued'
        WHERE tenant_id=$1 AND business_task_id='task-report-finalization'
          AND step_id='report_publish'`, [tenant]);
      await expect(client.query(
        'SET CONSTRAINTS gate_a_live_report_published_authority_guard IMMEDIATE',
      )).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects published authority while the exact execution attempt is running', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await stageExactTerminalPublication(client);
      await client.query(`UPDATE execution_attempts SET status='running',completed_at=NULL
        WHERE tenant_id=$1 AND id='execution-report-finalization'`, [tenant]);
      await expect(client.query(
        'SET CONSTRAINTS gate_a_live_report_published_authority_guard IMMEDIATE',
      )).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects published authority when the task result mirror is absent', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await stageExactTerminalPublication(client);
      await client.query(`UPDATE business_tasks SET result=NULL,result_record_variant=NULL
        WHERE tenant_id=$1 AND id='task-report-finalization'`, [tenant]);
      await expect(client.query(
        'SET CONSTRAINTS gate_a_live_report_published_authority_guard IMMEDIATE',
      )).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it.each([
    ['availability', "availability='missing'"],
    ['integrity', "integrity='pending'"],
    ['retention', "retention_expires_at=now()-interval '1 second'"],
    ['reconcile', "reconcile_status='required'"],
    ['etag', "etag_observed='different-etag'"],
  ])('rejects published authority when report artifact %s authority drifts', async (_kind, mutation) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await stageExactTerminalPublication(client);
      await client.query(`UPDATE artifact_states SET ${mutation}
        WHERE tenant_id=$1 AND artifact_id='artifact-report-finalization'`, [tenant]);
      await expect(client.query(
        'SET CONSTRAINTS gate_a_live_report_published_authority_guard IMMEDIATE',
      )).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('allows same-transaction finalization before publishing exact live authority', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await stageExactTerminalPublication(client);
      await expect(client.query(
        'SET CONSTRAINTS gate_a_live_report_published_authority_guard IMMEDIATE',
      )).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

});
