-- Gate A A.1: additive live-material authority. Historical simulation rows are
-- neither updated nor backfilled; every live insert supplies its discriminator.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Gate 0.2A stored only plain-text material. Gate A keeps those rows valid and
-- additively opens the same private artifact authority to the two reviewed
-- document formats; the application still enforces extension/media matching.
ALTER TABLE artifact_ingest_intents
  DROP CONSTRAINT IF EXISTS artifact_ingest_intents_media_type_check;
ALTER TABLE artifact_ingest_intents
  ADD CONSTRAINT artifact_ingest_intents_media_type_check CHECK (media_type IN (
    'text/plain','text/markdown','application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ));
ALTER TABLE artifact_ingest_intents
  DROP CONSTRAINT IF EXISTS artifact_ingest_intents_extension_check;
ALTER TABLE artifact_ingest_intents
  ADD CONSTRAINT artifact_ingest_intents_extension_check CHECK (extension IN ('txt','md','pdf','docx'));

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_media_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_media_type_check CHECK (media_type IN (
  'text/plain','text/markdown','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
));
ALTER TABLE artifact_manifests DROP CONSTRAINT IF EXISTS artifact_manifests_media_type_check;
ALTER TABLE artifact_manifests ADD CONSTRAINT artifact_manifests_media_type_check CHECK (media_type IN (
  'text/plain','text/markdown','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
));
ALTER TABLE document_snapshots DROP CONSTRAINT IF EXISTS document_snapshots_media_type_check;
ALTER TABLE document_snapshots ADD CONSTRAINT document_snapshots_media_type_check CHECK (media_type IN (
  'text/plain','text/markdown','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
));

ALTER TABLE artifact_ingest_intents
  ADD COLUMN IF NOT EXISTS ingest_mode text;
ALTER TABLE artifact_ingest_intents
  ADD CONSTRAINT artifact_ingest_intents_mode_check
  CHECK (ingest_mode IS NULL OR ingest_mode IN ('legacy','live_canonical'));

CREATE TABLE IF NOT EXISTS workflow_template_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  template_id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version='workflow-template-version/1'),
  capability_version_id text NOT NULL,
  harness_version_id text NOT NULL,
  workflow_draft_schema_version text NOT NULL,
  workflow_payload_schema_version text NOT NULL,
  compiler_version text NOT NULL,
  canonicalization_version text NOT NULL CHECK (canonicalization_version='RFC8785/JCS-1'),
  registry_digest text NOT NULL CHECK (registry_digest ~ '^[a-f0-9]{64}$'),
  canonical_entry jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,template_id),
  UNIQUE (tenant_id,registry_digest),
  CHECK (canonical_entry->>'templateId'=template_id),
  CHECK (canonical_entry->>'registryDigest'=registry_digest)
);

ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS record_variant text;
ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE workflow_versions ADD COLUMN IF NOT EXISTS registry_digest text;
ALTER TABLE workflow_versions ADD CONSTRAINT workflow_versions_gate_a_variant_check CHECK (
  (record_variant IS NULL AND template_id IS NULL AND registry_digest IS NULL)
  OR
  (record_variant='workflow-read-model.live/1'
    AND template_id IN ('workflow-template.solution-live/1','workflow-template.work-order-status/1')
    AND registry_digest ~ '^[a-f0-9]{64}$'
    AND canonical_json->>'schemaVersion'='workflow-version.template-v1')
);
ALTER TABLE workflow_versions ADD CONSTRAINT workflow_versions_gate_a_template_fk
  FOREIGN KEY (tenant_id,template_id) REFERENCES workflow_template_versions(tenant_id,template_id);

ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS record_variant text;
ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS result_record_variant text;
ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS semantic_fingerprint text;
ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS terminal_error_class text;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_gate_a_terminal_error_check CHECK (
  terminal_error_class IS NULL OR (record_variant='business-task.live/1' AND status='failed'
    AND terminal_error_class IN ('MODEL_ROUTE_UNAVAILABLE','MODEL_AUTH_FAILED','MODEL_QUOTA','MODEL_TIMEOUT',
      'MODEL_STREAM_INTERRUPTED','MODEL_PROTOCOL_VIOLATION','MODEL_BUSY','DATA_ROUTE_NOT_ALLOWED',
      'REPORT_AUTHORITY_INVALID','REPORT_PUBLICATION_FAILED','STORAGE_OPERATION_FAILED'))
);
ALTER TABLE business_tasks DROP CONSTRAINT IF EXISTS business_tasks_simulation_check;
ALTER TABLE business_tasks DROP CONSTRAINT IF EXISTS business_tasks_runtime_mode_check;
ALTER TABLE business_tasks DROP CONSTRAINT IF EXISTS business_tasks_business_decision_allowed_check;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_gate_a_variant_check CHECK (
  (simulation AND runtime_mode='fake' AND NOT business_decision_allowed
    AND record_variant IS NULL AND result_record_variant IS NULL AND semantic_fingerprint IS NULL)
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND record_variant='business-task.live/1'
    AND semantic_fingerprint ~ '^[a-f0-9]{64}$'
    AND ((result IS NULL AND result_record_variant IS NULL)
      OR (result IS NOT NULL AND result_record_variant='business-task-result.live/1')))
);
CREATE UNIQUE INDEX IF NOT EXISTS business_tasks_gate_a_semantic_fingerprint_uq
  ON business_tasks(tenant_id,requester_id,semantic_fingerprint)
  WHERE record_variant='business-task.live/1';

ALTER TABLE business_task_events ADD COLUMN IF NOT EXISTS record_variant text;
ALTER TABLE business_task_events DROP CONSTRAINT IF EXISTS business_task_events_simulation_check;
ALTER TABLE business_task_events DROP CONSTRAINT IF EXISTS business_task_events_runtime_mode_check;
ALTER TABLE business_task_events DROP CONSTRAINT IF EXISTS business_task_events_business_decision_allowed_check;
ALTER TABLE business_task_events ADD CONSTRAINT business_task_events_gate_a_variant_check CHECK (
  (simulation AND runtime_mode='fake' AND NOT business_decision_allowed
    AND schema_version=1 AND record_variant IS NULL)
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND schema_version=2 AND record_variant='business-task-event.live/1')
);

ALTER TABLE business_task_steps ADD COLUMN IF NOT EXISTS record_variant text;
ALTER TABLE business_task_steps DROP CONSTRAINT IF EXISTS business_task_steps_simulation_check;
ALTER TABLE business_task_steps DROP CONSTRAINT IF EXISTS business_task_steps_runtime_mode_check;
ALTER TABLE business_task_steps DROP CONSTRAINT IF EXISTS business_task_steps_business_decision_allowed_check;
ALTER TABLE business_task_steps ADD CONSTRAINT business_task_steps_gate_a_variant_check CHECK (
  (simulation AND runtime_mode='fake' AND NOT business_decision_allowed AND record_variant IS NULL)
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND record_variant='business-task-step.live/1')
);

CREATE OR REPLACE FUNCTION ensure_gate_a_task_relation_variant() RETURNS trigger AS $$
DECLARE
  task_variant text;
  task_simulation boolean;
  task_runtime_mode text;
  task_business_decision_allowed boolean;
BEGIN
  SELECT record_variant,simulation,runtime_mode,business_decision_allowed
    INTO task_variant,task_simulation,task_runtime_mode,task_business_decision_allowed
    FROM business_tasks
   WHERE tenant_id=NEW.tenant_id AND id=NEW.business_task_id;

  IF task_variant IS NULL THEN
    IF task_simulation IS DISTINCT FROM true
      OR task_runtime_mode IS DISTINCT FROM 'fake'
      OR task_business_decision_allowed IS DISTINCT FROM false
      OR NEW.record_variant IS DISTINCT FROM NULL
      OR NEW.simulation IS DISTINCT FROM true
      OR NEW.runtime_mode IS DISTINCT FROM 'fake'
      OR NEW.business_decision_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'legacy task relation must use the exact legacy selector tuple';
    END IF;
    IF TG_TABLE_NAME='business_task_events' THEN
      IF NEW.schema_version IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'legacy task event must use schema_version=1';
      END IF;
    END IF;
  ELSIF task_variant IS DISTINCT FROM 'business-task.live/1'
    OR task_simulation IS DISTINCT FROM false
    OR task_runtime_mode IS DISTINCT FROM 'model_gateway'
    OR task_business_decision_allowed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'task root has an invalid selector tuple';
  ELSE
    IF NEW.simulation IS DISTINCT FROM false
      OR NEW.runtime_mode IS DISTINCT FROM 'model_gateway'
      OR NEW.business_decision_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'live task relation must use the exact live selector tuple';
    END IF;
    IF TG_TABLE_NAME='business_task_events' THEN
      IF NEW.record_variant IS DISTINCT FROM 'business-task-event.live/1'
        OR NEW.schema_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'live task event must use the exact live selector tuple';
      END IF;
    ELSIF TG_TABLE_NAME='business_task_steps'
      AND NEW.record_variant IS DISTINCT FROM 'business-task-step.live/1' THEN
      RAISE EXCEPTION 'live task step must use the exact live selector tuple';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS business_task_events_gate_a_variant_guard ON business_task_events;
CREATE CONSTRAINT TRIGGER business_task_events_gate_a_variant_guard
  AFTER INSERT OR UPDATE ON business_task_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_task_relation_variant();
DROP TRIGGER IF EXISTS business_task_steps_gate_a_variant_guard ON business_task_steps;
CREATE CONSTRAINT TRIGGER business_task_steps_gate_a_variant_guard
  AFTER INSERT OR UPDATE ON business_task_steps DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_task_relation_variant();

CREATE TABLE IF NOT EXISTS parser_manifests (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version IN ('parser-manifest.gate-a/1','parser-manifest.gate-a/2')),
  media_type text NOT NULL CHECK (media_type IN ('text/plain','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  parser_name text NOT NULL CHECK (parser_name IN ('geneway-plain-text-parser','geneway-document-parser')),
  parser_version text NOT NULL CHECK (parser_version IN ('1.0.0','1.0.0-candidate.1')),
  executable_digest text NOT NULL CHECK (executable_digest ~ '^[a-f0-9]{64}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^[a-f0-9]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  registry_source text NOT NULL,
  upstream_source text NOT NULL,
  lock_resolution text NOT NULL,
  lock_integrity text NOT NULL CHECK (lock_integrity ~ '^[a-f0-9]{64}$'),
  license text NOT NULL,
  dependencies jsonb NOT NULL CHECK (jsonb_typeof(dependencies)='array'),
  conversion_config jsonb NOT NULL CHECK (jsonb_typeof(conversion_config)='object'),
  canonical_manifest jsonb NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,manifest_digest),
  FOREIGN KEY (tenant_id,approved_by) REFERENCES users(tenant_id,id),
  CHECK (expires_at>approved_at)
);

CREATE TABLE IF NOT EXISTS document_snapshot_canonical_representations (
  tenant_id text NOT NULL,
  document_snapshot_id text NOT NULL,
  parser_manifest_id text NOT NULL,
  parser_digest text NOT NULL CHECK (parser_digest ~ '^[a-f0-9]{64}$'),
  extraction_version text NOT NULL CHECK (extraction_version IN ('canonical-text/plain-utf8/1','canonical-text/pdf-pages-utf8/1','canonical-text/docx-pages-utf8/1')),
  canonical_bytes bytea NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 1 AND 2097152),
  canonical_text_sha256 text NOT NULL CHECK (canonical_text_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_page_index jsonb,
  canonical_page_index_sha256 text CHECK (canonical_page_index_sha256 IS NULL OR canonical_page_index_sha256 ~ '^[a-f0-9]{64}$'),
  resource_limits_version text NOT NULL CHECK (resource_limits_version IN ('gate-a-parser-limits/1','gate-a-document-parser-limits-candidate/1')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,document_snapshot_id),
  FOREIGN KEY (tenant_id,document_snapshot_id) REFERENCES document_snapshots(tenant_id,id),
  FOREIGN KEY (tenant_id,parser_manifest_id) REFERENCES parser_manifests(tenant_id,id),
  CHECK (canonical_text_sha256=encode(digest(canonical_bytes,'sha256'),'hex')),
  CHECK ((canonical_page_index IS NULL)=(canonical_page_index_sha256 IS NULL))
);

CREATE TABLE IF NOT EXISTS gate_a_classified_document_sources (
  tenant_id text NOT NULL REFERENCES tenants(id),
  source_artifact_id text NOT NULL,
  source_document_snapshot_id text NOT NULL,
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  source_canonical_text_sha256 text NOT NULL CHECK (source_canonical_text_sha256 ~ '^[a-f0-9]{64}$'),
  data_class text NOT NULL CHECK (data_class='C2'),
  record_variant text NOT NULL CHECK (record_variant='document-classification.c2/1'),
  classification_authority_id text NOT NULL,
  classified_by text NOT NULL,
  classified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,source_document_snapshot_id),
  UNIQUE (tenant_id,source_artifact_id),
  UNIQUE (tenant_id,source_artifact_id,source_document_snapshot_id,source_artifact_sha256,source_canonical_text_sha256),
  FOREIGN KEY (tenant_id,classified_by) REFERENCES users(tenant_id,id)
);


CREATE TABLE IF NOT EXISTS deidentification_reclassification_records (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version='deidentification-reclassification-record/1'),
  source_artifact_id text NOT NULL,
  source_document_snapshot_id text NOT NULL,
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  source_canonical_text_sha256 text NOT NULL CHECK (source_canonical_text_sha256 ~ '^[a-f0-9]{64}$'),
  source_data_class text NOT NULL CHECK (source_data_class='C2'),
  output_artifact_id text NOT NULL,
  output_document_snapshot_id text NOT NULL,
  output_artifact_sha256 text NOT NULL CHECK (output_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  output_canonical_text_sha256 text NOT NULL CHECK (output_canonical_text_sha256 ~ '^[a-f0-9]{64}$'),
  output_data_class text NOT NULL CHECK (output_data_class='C1'),
  transformer_name text NOT NULL,
  transformer_version text NOT NULL,
  transformer_digest text NOT NULL CHECK (transformer_digest ~ '^[a-f0-9]{64}$'),
  deidentification_policy_version text NOT NULL,
  detection_result jsonb NOT NULL,
  lineage_record_ids jsonb NOT NULL,
  approval_actor_id text NOT NULL,
  approval_role text NOT NULL CHECK (approval_role='gate-a-data-reclassification-approver'),
  authorization_decision_id text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,output_document_snapshot_id),
  FOREIGN KEY (tenant_id,approval_actor_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,source_artifact_id,source_document_snapshot_id,source_artifact_sha256,source_canonical_text_sha256)
    REFERENCES gate_a_classified_document_sources(
      tenant_id,source_artifact_id,source_document_snapshot_id,source_artifact_sha256,source_canonical_text_sha256),
  FOREIGN KEY (tenant_id,output_artifact_id) REFERENCES artifacts(tenant_id,id),
  FOREIGN KEY (tenant_id,output_document_snapshot_id) REFERENCES document_snapshots(tenant_id,id),
  CHECK (source_artifact_id<>output_artifact_id),
  CHECK (source_document_snapshot_id<>output_document_snapshot_id),
  CHECK (source_artifact_sha256<>output_artifact_sha256),
  CHECK (source_canonical_text_sha256<>output_canonical_text_sha256),
  CHECK (expires_at>approved_at),
  CHECK (revoked_at IS NULL OR revoked_at>=approved_at)
);

CREATE TABLE IF NOT EXISTS gate_a_model_invocations (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  workflow_version_id text NOT NULL,
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[a-f0-9]{64}$'),
  step_id text NOT NULL,
  execution_attempt_id text NOT NULL,
  step_attempt_id text NOT NULL,
  task_fence bigint NOT NULL CHECK (task_fence>0),
  step_fence bigint NOT NULL CHECK (step_fence>0),
  approval_subject_digest text NOT NULL CHECK (approval_subject_digest ~ '^[a-f0-9]{64}$'),
  capability_version_id text NOT NULL,
  prompt_policy_version_id text NOT NULL,
  expert_target_digest text NOT NULL CHECK (expert_target_digest ~ '^[a-f0-9]{64}$'),
  parser_manifest_id text NOT NULL,
  document_snapshot_id text NOT NULL,
  canonical_text_sha256 text NOT NULL CHECK (canonical_text_sha256 ~ '^[a-f0-9]{64}$'),
  logical_model_policy text NOT NULL CHECK (logical_model_policy='business.solution.analysis.standard'),
  route_profile text NOT NULL CHECK (route_profile='codex_subscription_dev'),
  data_class text NOT NULL CHECK (data_class='C1'),
  status text NOT NULL CHECK (status IN ('pending','running','cancel_requested','completed','canceled','failed')),
  output_payload_digest text CHECK (output_payload_digest IS NULL OR output_payload_digest ~ '^[a-f0-9]{64}$'),
  provider_revision text,
  model_revision text,
  usage jsonb,
  error_class text CHECK (error_class IS NULL OR error_class IN (
    'MODEL_ROUTE_UNAVAILABLE','MODEL_AUTH_FAILED','MODEL_QUOTA','MODEL_TIMEOUT',
    'MODEL_STREAM_INTERRUPTED','MODEL_PROTOCOL_VIOLATION','MODEL_BUSY',
    'DATA_ROUTE_NOT_ALLOWED'
  )),
  deadline timestamptz NOT NULL,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id,step_id,step_attempt_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,workflow_version_id) REFERENCES workflow_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,parser_manifest_id) REFERENCES parser_manifests(tenant_id,id),
  FOREIGN KEY (tenant_id,document_snapshot_id) REFERENCES document_snapshots(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS gate_a_model_invocation_token_authorizations (
  tenant_id text NOT NULL,
  jti uuid NOT NULL,
  model_invocation_id text NOT NULL,
  task_fence bigint NOT NULL CHECK (task_fence>0),
  step_fence bigint NOT NULL CHECK (step_fence>0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,jti),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES gate_a_model_invocations(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS gate_a_live_results (
  tenant_id text NOT NULL,
  business_task_id text NOT NULL,
  record_variant text NOT NULL CHECK (record_variant='business-task-result.live/1'),
  model_invocation_id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version='analysis-result/1'),
  result jsonb NOT NULL,
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_result_bytes bytea NOT NULL CHECK (octet_length(canonical_result_bytes) BETWEEN 1 AND 262144),
  publication_state text NOT NULL DEFAULT 'staging' CHECK (publication_state IN ('staging','published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,business_task_id),
  UNIQUE (tenant_id,business_task_id,model_invocation_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES gate_a_model_invocations(tenant_id,id),
  CHECK (result_sha256=encode(digest(canonical_result_bytes,'sha256'),'hex'))
);

CREATE TABLE IF NOT EXISTS gate_a_live_evidence (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  record_variant text NOT NULL CHECK (record_variant='evidence.live/1'),
  document_snapshot_id text NOT NULL,
  locator jsonb NOT NULL,
  excerpt_bytes bytea NOT NULL CHECK (octet_length(excerpt_bytes) BETWEEN 1 AND 16384),
  excerpt_sha256 text NOT NULL CHECK (excerpt_sha256 ~ '^[a-f0-9]{64}$'),
  resource_scope text NOT NULL,
  data_class text NOT NULL CHECK (data_class='C1'),
  audience text NOT NULL CHECK (audience ~ '^conversation:[^[:space:]]+$'),
  accessible boolean NOT NULL DEFAULT false,
  publication_state text NOT NULL DEFAULT 'staging' CHECK (publication_state IN ('staging','published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,document_snapshot_id) REFERENCES document_snapshots(tenant_id,id),
  CHECK (excerpt_sha256=encode(digest(excerpt_bytes,'sha256'),'hex')),
  CHECK ((locator->>'excerptByteLength')::bigint=octet_length(excerpt_bytes)),
  CHECK ((publication_state='staging' AND NOT accessible)
    OR (publication_state='published' AND accessible))
);

CREATE TABLE IF NOT EXISTS gate_a_live_claims (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  record_variant text NOT NULL CHECK (record_variant='claim.live/1'),
  statement_id text NOT NULL,
  statement_kind text NOT NULL CHECK (statement_kind IN ('fact','inference','recommendation','unknown')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8192),
  confidence numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status text NOT NULL CHECK (status IN ('published','rejected')),
  rejection_code text,
  publication_state text NOT NULL DEFAULT 'staging' CHECK (publication_state IN ('staging','published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id,statement_id),
  UNIQUE (tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  CHECK ((status='published' AND rejection_code IS NULL) OR (status='rejected' AND rejection_code IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS gate_a_live_evidence_links (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  claim_id text NOT NULL,
  evidence_id text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports','depends_on')),
  publication_state text NOT NULL DEFAULT 'staging' CHECK (publication_state IN ('staging','published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,claim_id,evidence_id,relation),
  FOREIGN KEY (tenant_id,claim_id,business_task_id) REFERENCES gate_a_live_claims(tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,evidence_id,business_task_id) REFERENCES gate_a_live_evidence(tenant_id,id,business_task_id)
);

CREATE OR REPLACE FUNCTION ensure_gate_a_fact_has_evidence() RETURNS trigger AS $$
BEGIN
  IF NEW.publication_state='published' AND NEW.statement_kind='fact' AND NEW.status='published' AND NOT EXISTS (
    SELECT 1 FROM gate_a_live_evidence_links link
    JOIN gate_a_live_evidence evidence ON evidence.tenant_id=link.tenant_id AND evidence.id=link.evidence_id
     WHERE link.tenant_id=NEW.tenant_id AND link.business_task_id=NEW.business_task_id
       AND link.claim_id=NEW.id AND link.relation='supports' AND link.publication_state='published'
       AND evidence.publication_state='published' AND evidence.accessible
  ) THEN
    RAISE EXCEPTION 'published Gate A fact requires verified Evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS gate_a_live_claim_evidence_guard ON gate_a_live_claims;
CREATE CONSTRAINT TRIGGER gate_a_live_claim_evidence_guard
  AFTER INSERT OR UPDATE ON gate_a_live_claims DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_fact_has_evidence();

CREATE OR REPLACE FUNCTION ensure_gate_a_live_task_publication_terminal() RETURNS trigger AS $$
BEGIN
  IF NEW.record_variant='business-task.live/1' AND NEW.status='completed' AND (
    NOT EXISTS (SELECT 1 FROM gate_a_live_results result
      WHERE result.tenant_id=NEW.tenant_id AND result.business_task_id=NEW.id
        AND result.publication_state='published')
    OR EXISTS (SELECT 1 FROM gate_a_live_claims claim
      WHERE claim.tenant_id=NEW.tenant_id AND claim.business_task_id=NEW.id
        AND claim.publication_state<>'published')
    OR EXISTS (SELECT 1 FROM gate_a_live_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id
        AND (evidence.publication_state<>'published' OR NOT evidence.accessible))
    OR EXISTS (SELECT 1 FROM gate_a_live_evidence_links link
      WHERE link.tenant_id=NEW.tenant_id AND link.business_task_id=NEW.id
        AND link.publication_state<>'published')
    OR NOT EXISTS (SELECT 1 FROM gate_a_live_report_publish_intents intent
      WHERE intent.tenant_id=NEW.tenant_id AND intent.business_task_id=NEW.id
        AND intent.status='published')
    OR NOT EXISTS (SELECT 1 FROM gate_a_live_reports report
      WHERE report.tenant_id=NEW.tenant_id AND report.business_task_id=NEW.id)
  ) THEN
    RAISE EXCEPTION 'completed Gate A live task requires one atomic published result/evidence/report authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS record_variant text;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('source_document','simulation_report','analysis_report'));
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_source_xor_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_source_xor_check CHECK (
  (kind='source_document' AND record_variant IS NULL AND business_task_id IS NULL AND root_artifact_id=id
    AND business_exception_source_version_id IS NULL AND resource_scope='artifact:' || id)
  OR
  (kind='simulation_report' AND record_variant IS NULL AND business_task_id IS NOT NULL AND (
    (root_artifact_id IS NOT NULL AND root_artifact_id<>id
      AND business_exception_source_version_id IS NULL AND resource_scope='artifact:' || root_artifact_id)
    OR (root_artifact_id IS NULL AND business_exception_source_version_id IS NOT NULL)
  ))
  OR
  (kind='analysis_report' AND record_variant='artifact.analysis-report.live/1'
    AND business_task_id IS NOT NULL AND root_artifact_id IS NOT NULL AND root_artifact_id<>id
    AND business_exception_source_version_id IS NULL AND resource_scope='artifact:' || root_artifact_id)
);

CREATE OR REPLACE FUNCTION ensure_artifact_root_is_source() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('simulation_report','analysis_report') AND NEW.root_artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifacts root WHERE root.tenant_id=NEW.tenant_id AND root.id=NEW.root_artifact_id
      AND root.kind='source_document' AND root.conversation_id=NEW.conversation_id
      AND root.owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'report root must be a source document in the same private conversation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS gate_a_live_reports (
  tenant_id text NOT NULL,
  artifact_id text NOT NULL,
  business_task_id text NOT NULL,
  record_variant text NOT NULL CHECK (record_variant='artifact.analysis-report.live/1'),
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
  workflow_version_id text NOT NULL,
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[a-f0-9]{64}$'),
  model_invocation_id text NOT NULL,
  renderer_version text NOT NULL CHECK (renderer_version='analysis-report-renderer/1'),
  internal_acceptance boolean NOT NULL CHECK (internal_acceptance),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,artifact_id),
  UNIQUE (tenant_id,business_task_id),
  FOREIGN KEY (tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES gate_a_live_results(tenant_id,business_task_id),
  FOREIGN KEY (tenant_id,workflow_version_id) REFERENCES workflow_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES gate_a_model_invocations(tenant_id,id)
);

CREATE INDEX IF NOT EXISTS gate_a_model_invocations_task_idx
  ON gate_a_model_invocations(tenant_id,business_task_id,created_at);
CREATE INDEX IF NOT EXISTS gate_a_live_evidence_task_idx
  ON gate_a_live_evidence(tenant_id,business_task_id,created_at);
-- Exact Gate A authority tuples. Nullable/generated columns preserve historical
-- simulation rows while live rows are bound end-to-end by composite foreign keys.
ALTER TABLE workflow_template_versions ADD CONSTRAINT workflow_template_versions_registry_tuple_uq
  UNIQUE (tenant_id,template_id,registry_digest);
ALTER TABLE workflow_versions ADD CONSTRAINT workflow_versions_hash_tuple_uq
  UNIQUE (tenant_id,id,workflow_hash);
ALTER TABLE workflow_versions ADD CONSTRAINT workflow_versions_live_registry_tuple_uq
  UNIQUE (tenant_id,id,workflow_hash,record_variant,template_id,registry_digest);
ALTER TABLE workflow_versions DROP CONSTRAINT workflow_versions_gate_a_template_fk;
ALTER TABLE workflow_versions ADD CONSTRAINT workflow_versions_gate_a_template_fk
  FOREIGN KEY (tenant_id,template_id,registry_digest)
  REFERENCES workflow_template_versions(tenant_id,template_id,registry_digest);

ALTER TABLE artifacts ADD CONSTRAINT artifacts_content_tuple_uq
  UNIQUE (tenant_id,id,content_sha256);
ALTER TABLE document_snapshots ADD CONSTRAINT document_snapshots_content_tuple_uq
  UNIQUE (tenant_id,id,artifact_id,content_sha256);
ALTER TABLE parser_manifests ADD CONSTRAINT parser_manifests_digest_tuple_uq
  UNIQUE (tenant_id,id,manifest_digest);
ALTER TABLE document_snapshot_canonical_representations
  ADD CONSTRAINT document_snapshot_canonical_tuple_uq
    UNIQUE (tenant_id,document_snapshot_id,parser_manifest_id,parser_digest,
      extraction_version,canonical_text_sha256),
  ADD CONSTRAINT document_snapshot_parser_digest_fk
    FOREIGN KEY (tenant_id,parser_manifest_id,parser_digest)
    REFERENCES parser_manifests(tenant_id,id,manifest_digest),
  ADD CONSTRAINT document_snapshot_canonical_utf8_check
    CHECK (convert_from(canonical_bytes,'UTF8') IS NOT NULL);

ALTER TABLE business_tasks
  ADD COLUMN input_document_snapshot_id text GENERATED ALWAYS AS (
    CASE WHEN record_variant='business-task.live/1' THEN input_snapshot->>'documentSnapshotId' END
  ) STORED,
  ADD COLUMN input_artifact_id text GENERATED ALWAYS AS (
    CASE WHEN record_variant='business-task.live/1' THEN input_snapshot->>'artifactId' END
  ) STORED,
  ADD COLUMN input_artifact_sha256 text GENERATED ALWAYS AS (
    CASE WHEN record_variant='business-task.live/1' THEN input_snapshot->>'artifactSha256' END
  ) STORED,
  ADD COLUMN input_parser_manifest_id text GENERATED ALWAYS AS (
    CASE WHEN record_variant='business-task.live/1' THEN input_snapshot->>'parserManifestId' END
  ) STORED,
  ADD COLUMN input_parser_digest text GENERATED ALWAYS AS (
    CASE WHEN record_variant='business-task.live/1' THEN input_snapshot->>'parserDigest' END
  ) STORED,
  ADD COLUMN input_extraction_version text GENERATED ALWAYS AS (
    CASE WHEN record_variant='business-task.live/1' THEN input_snapshot->>'extractionVersion' END
  ) STORED,
  ADD COLUMN input_canonical_text_sha256 text GENERATED ALWAYS AS (
    CASE WHEN record_variant='business-task.live/1' THEN input_snapshot->>'canonicalTextSha256' END
  ) STORED,
  ADD CONSTRAINT business_tasks_live_input_shape_check CHECK (
    record_variant IS NULL OR (
      input_snapshot->>'kind'='live_document_snapshot'
      AND input_snapshot->>'recordVariant'='business-task-input.live-material/1'
      AND input_snapshot->>'dataClass'='C1'
      AND input_snapshot->>'trust'='untrusted_text'
      AND input_snapshot->>'resourceScope'='artifact:' || input_artifact_id
      AND input_document_snapshot_id IS NOT NULL
      AND input_artifact_id IS NOT NULL
      AND input_artifact_sha256 ~ '^[a-f0-9]{64}$'
      AND input_parser_manifest_id IS NOT NULL
      AND input_parser_digest ~ '^[a-f0-9]{64}$'
      AND input_extraction_version IN ('canonical-text/plain-utf8/1','canonical-text/pdf-pages-utf8/1','canonical-text/docx-pages-utf8/1')
      AND input_canonical_text_sha256 ~ '^[a-f0-9]{64}$'
    )
  ),
  ADD CONSTRAINT business_tasks_selector_workflow_tuple_uq
    UNIQUE (tenant_id,id,record_variant,workflow_version_id,workflow_hash),
  ADD CONSTRAINT business_tasks_live_input_tuple_uq
    UNIQUE (tenant_id,id,workflow_version_id,workflow_hash,input_document_snapshot_id,
      input_artifact_id,input_artifact_sha256,input_parser_manifest_id,input_parser_digest,
      input_extraction_version,input_canonical_text_sha256),
  ADD CONSTRAINT business_tasks_workflow_hash_fk
    FOREIGN KEY (tenant_id,workflow_version_id,workflow_hash)
    REFERENCES workflow_versions(tenant_id,id,workflow_hash),
  ADD CONSTRAINT business_tasks_live_artifact_fk
    FOREIGN KEY (tenant_id,input_artifact_id,input_artifact_sha256)
    REFERENCES artifacts(tenant_id,id,content_sha256),
  ADD CONSTRAINT business_tasks_live_snapshot_fk
    FOREIGN KEY (tenant_id,input_document_snapshot_id,input_artifact_id,input_artifact_sha256)
    REFERENCES document_snapshots(tenant_id,id,artifact_id,content_sha256),
  ADD CONSTRAINT business_tasks_live_canonical_fk
    FOREIGN KEY (tenant_id,input_document_snapshot_id,input_parser_manifest_id,input_parser_digest,
      input_extraction_version,input_canonical_text_sha256)
    REFERENCES document_snapshot_canonical_representations(
      tenant_id,document_snapshot_id,parser_manifest_id,parser_digest,extraction_version,canonical_text_sha256);

ALTER TABLE gate_a_classified_document_sources
  ADD COLUMN source_canonical_bytes bytea NOT NULL
    CHECK (octet_length(source_canonical_bytes) BETWEEN 1 AND 1048576),
  ADD COLUMN classification_decision jsonb NOT NULL,
  ADD CONSTRAINT gate_a_classified_source_bytes_digest_check
    CHECK (source_canonical_text_sha256=encode(digest(source_canonical_bytes,'sha256'),'hex')),
  ADD CONSTRAINT gate_a_classified_source_utf8_check
    CHECK (convert_from(source_canonical_bytes,'UTF8') IS NOT NULL),
  ADD CONSTRAINT gate_a_classified_source_decision_check CHECK (
    jsonb_typeof(classification_decision)='object'
    AND classification_decision->>'schemaVersion'='document-classification-decision/1'
    AND classification_decision->>'authorityId'=classification_authority_id
    AND classification_decision->>'actorId'=classified_by
    AND classification_decision->>'dataClass'='C2'
    AND classification_decision->>'allowed'='true'
  );

ALTER TABLE deidentification_reclassification_records
  ADD COLUMN output_parser_manifest_id text NOT NULL,
  ADD COLUMN output_parser_digest text NOT NULL CHECK (output_parser_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN output_extraction_version text NOT NULL
    CHECK (output_extraction_version='canonical-text/plain-utf8/1'),
  ADD CONSTRAINT reclassification_detection_result_check CHECK (
    jsonb_typeof(detection_result)='object'
    AND detection_result->>'schemaVersion'='deidentification-detection/1'
    AND detection_result->>'passed'='true'
    AND detection_result->>'outputSha256'=output_canonical_text_sha256
    AND detection_result->>'findingsDigest' ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT reclassification_lineage_check CHECK (
    jsonb_typeof(lineage_record_ids)='array' AND jsonb_array_length(lineage_record_ids)>=2
  ),
  ADD CONSTRAINT reclassification_output_artifact_fk
    FOREIGN KEY (tenant_id,output_artifact_id,output_artifact_sha256)
    REFERENCES artifacts(tenant_id,id,content_sha256),
  ADD CONSTRAINT reclassification_output_snapshot_fk
    FOREIGN KEY (tenant_id,output_document_snapshot_id,output_artifact_id,output_artifact_sha256)
    REFERENCES document_snapshots(tenant_id,id,artifact_id,content_sha256),
  ADD CONSTRAINT reclassification_output_canonical_fk
    FOREIGN KEY (tenant_id,output_document_snapshot_id,output_parser_manifest_id,output_parser_digest,
      output_extraction_version,output_canonical_text_sha256)
    REFERENCES document_snapshot_canonical_representations(
      tenant_id,document_snapshot_id,parser_manifest_id,parser_digest,extraction_version,canonical_text_sha256);

CREATE TABLE gate_a_reclassification_revocations (
  tenant_id text NOT NULL,
  reclassification_record_id text NOT NULL,
  revocation_decision_id text NOT NULL,
  revoked_by text NOT NULL,
  revoked_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,reclassification_record_id),
  UNIQUE (tenant_id,revocation_decision_id),
  FOREIGN KEY (tenant_id,reclassification_record_id)
    REFERENCES deidentification_reclassification_records(tenant_id,id),
  FOREIGN KEY (tenant_id,revoked_by) REFERENCES users(tenant_id,id)
);

ALTER TABLE gate_a_model_invocations
  ADD COLUMN artifact_id text NOT NULL,
  ADD COLUMN artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN canonical_page_index_sha256 text
    CHECK (canonical_page_index_sha256 IS NULL OR canonical_page_index_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN parser_digest text NOT NULL CHECK (parser_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN extraction_version text NOT NULL
    CHECK (extraction_version IN ('canonical-text/plain-utf8/1','canonical-text/pdf-pages-utf8/1','canonical-text/docx-pages-utf8/1')),
  ADD COLUMN resource_scope text NOT NULL,
  ADD COLUMN canonical_selection_projection jsonb NOT NULL
    CHECK (jsonb_typeof(canonical_selection_projection)='object'
      AND canonical_selection_projection ?& ARRAY[
        'schemaVersion','selectionPolicyVersion','sourceExtractionVersion',
        'sourceCanonicalTextSha256','sourceCanonicalByteLength','sourceCanonicalPageIndexSha256',
        'selectedParagraphs','selectedTotalBytes','selectedModelInputSha256','truncated'
      ]
      AND canonical_selection_projection->>'schemaVersion'='canonical-selection-projection.gate-a/1'
      AND canonical_selection_projection->>'selectionPolicyVersion'='canonical-complete-paragraph-concat/1'
      AND canonical_selection_projection->>'sourceExtractionVersion'=extraction_version
      AND canonical_selection_projection->>'sourceCanonicalTextSha256'=canonical_text_sha256
      AND COALESCE(canonical_selection_projection->>'sourceCanonicalPageIndexSha256','')
        =COALESCE(canonical_page_index_sha256,'')
      AND jsonb_typeof(canonical_selection_projection->'sourceCanonicalByteLength')='number'
      AND (canonical_selection_projection->>'sourceCanonicalByteLength')::integer BETWEEN 1 AND 2097152
      AND jsonb_typeof(canonical_selection_projection->'selectedParagraphs')='array'
      AND jsonb_array_length(canonical_selection_projection->'selectedParagraphs') BETWEEN 1 AND 4096
      AND jsonb_typeof(canonical_selection_projection->'selectedTotalBytes')='number'
      AND (canonical_selection_projection->>'selectedTotalBytes')::integer BETWEEN 1 AND 262144
      AND canonical_selection_projection->>'selectedModelInputSha256' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(canonical_selection_projection->'truncated')='boolean'),
  ADD COLUMN canonical_selection_projection_digest text NOT NULL
    CHECK (canonical_selection_projection_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN selected_model_input_sha256 text NOT NULL
    CHECK (selected_model_input_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN material_projection_digest text NOT NULL CHECK (material_projection_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN prompt_policy_resolved_bytes_sha256 text NOT NULL
    CHECK (prompt_policy_resolved_bytes_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN provider_input_projection_digest text NOT NULL
    CHECK (provider_input_projection_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN prior_step_outputs_digest text NOT NULL
    CHECK (prior_step_outputs_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN evidence_candidate_projection jsonb NOT NULL
    CHECK (jsonb_typeof(evidence_candidate_projection)='array'
      AND jsonb_array_length(evidence_candidate_projection) BETWEEN 1 AND 128),
  ADD COLUMN agent_registry_reference text NOT NULL CHECK (agent_registry_reference IN (
    'agent.solution.requirement/live-1','agent.solution.contradiction/live-1','agent.solution.architect/live-1'
  )),
  ADD COLUMN tool_choice text NOT NULL CHECK (tool_choice='none'),
  ADD COLUMN output_schema_version text NOT NULL CHECK (output_schema_version IN (
    'analysis.requirement-candidates/1','analysis.contradiction/1','analysis.result-candidate/1'
  )),
  ADD COLUMN max_input_bytes integer NOT NULL CHECK (max_input_bytes BETWEEN 1 AND 1048576),
  ADD COLUMN max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 16384),
  ADD CONSTRAINT gate_a_model_invocations_agent_authority_check CHECK (
    (step_id='requirement_extract' AND agent_registry_reference='agent.solution.requirement/live-1'
      AND output_schema_version='analysis.requirement-candidates/1')
    OR (step_id='contradiction_check' AND agent_registry_reference='agent.solution.contradiction/live-1'
      AND output_schema_version='analysis.contradiction/1')
    OR (step_id='solution_design' AND agent_registry_reference='agent.solution.architect/live-1'
      AND output_schema_version='analysis.result-candidate/1')
  ),
  ADD CONSTRAINT gate_a_model_invocations_selection_hash_check CHECK (
    canonical_selection_projection->>'selectedModelInputSha256'=selected_model_input_sha256
  ),
  ADD CONSTRAINT gate_a_model_invocations_task_tuple_uq
    UNIQUE (tenant_id,business_task_id,id),
  ADD CONSTRAINT gate_a_model_invocations_authority_tuple_uq
    UNIQUE (tenant_id,business_task_id,id,workflow_version_id,workflow_hash),
  ADD CONSTRAINT gate_a_model_invocations_selection_authority_tuple_uq
    UNIQUE (tenant_id,business_task_id,id,canonical_selection_projection_digest,selected_model_input_sha256),
  ADD CONSTRAINT gate_a_model_invocations_task_authority_fk
    FOREIGN KEY (tenant_id,business_task_id,workflow_version_id,workflow_hash,
      document_snapshot_id,artifact_id,artifact_sha256,parser_manifest_id,parser_digest,
      extraction_version,canonical_text_sha256)
    REFERENCES business_tasks(
      tenant_id,id,workflow_version_id,workflow_hash,input_document_snapshot_id,
      input_artifact_id,input_artifact_sha256,input_parser_manifest_id,input_parser_digest,
      input_extraction_version,input_canonical_text_sha256);

CREATE OR REPLACE FUNCTION protect_gate_a_invocation_candidate_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_candidate_projection IS DISTINCT FROM OLD.evidence_candidate_projection THEN
    RAISE EXCEPTION 'Gate A invocation-approved Evidence candidate projection is immutable';
  END IF;
  IF NEW.canonical_selection_projection IS DISTINCT FROM OLD.canonical_selection_projection
    OR NEW.canonical_selection_projection_digest IS DISTINCT FROM OLD.canonical_selection_projection_digest
    OR NEW.selected_model_input_sha256 IS DISTINCT FROM OLD.selected_model_input_sha256 THEN
    RAISE EXCEPTION 'Gate A invocation canonical selection projection is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS gate_a_model_invocations_candidate_projection_immutable ON gate_a_model_invocations;
CREATE TRIGGER gate_a_model_invocations_candidate_projection_immutable
BEFORE UPDATE ON gate_a_model_invocations FOR EACH ROW
EXECUTE FUNCTION protect_gate_a_invocation_candidate_projection();

ALTER TABLE gate_a_live_results
  ADD CONSTRAINT gate_a_live_results_invocation_task_fk
    FOREIGN KEY (tenant_id,business_task_id,model_invocation_id)
    REFERENCES gate_a_model_invocations(tenant_id,business_task_id,id),
  ADD CONSTRAINT gate_a_live_results_result_tuple_uq
    UNIQUE (tenant_id,business_task_id,model_invocation_id,result_sha256);

ALTER TABLE business_tasks
  ADD CONSTRAINT business_tasks_live_material_tuple_uq
    UNIQUE (tenant_id,id,input_document_snapshot_id,input_artifact_id,input_artifact_sha256,
      input_parser_manifest_id,input_parser_digest,input_extraction_version,input_canonical_text_sha256);

ALTER TABLE gate_a_live_evidence
  ADD COLUMN artifact_id text GENERATED ALWAYS AS (locator->>'sourceArtifactId') STORED,
  ADD COLUMN artifact_sha256 text GENERATED ALWAYS AS (locator->>'sourceArtifactSha256') STORED,
  ADD COLUMN canonical_text_sha256 text GENERATED ALWAYS AS (locator->>'canonicalTextSha256') STORED,
  ADD COLUMN parser_manifest_id text GENERATED ALWAYS AS (locator->>'parserManifestId') STORED,
  ADD COLUMN parser_digest text GENERATED ALWAYS AS (locator->>'parserDigest') STORED,
  ADD COLUMN extraction_version text GENERATED ALWAYS AS (locator->>'extractionVersion') STORED,
  ADD CONSTRAINT gate_a_live_evidence_locator_shape_check CHECK (
    jsonb_typeof(locator)='object'
    AND locator->>'schemaVersion'='evidence-locator.live/1'
    AND locator->>'kind' IN ('canonical_text_span','canonical_page_span')
    AND locator->>'documentSnapshotId'=document_snapshot_id
    AND locator->>'excerptSha256'=excerpt_sha256
    AND locator ?& ARRAY['schemaVersion','kind','sourceArtifactId','sourceArtifactSha256',
      'documentSnapshotId','canonicalTextSha256','parserManifestId','parserDigest',
      'extractionVersion','excerptSha256','excerptByteLength','startByte','endByteExclusive']
    AND (locator - ARRAY['schemaVersion','kind','sourceArtifactId','sourceArtifactSha256',
      'documentSnapshotId','canonicalTextSha256','parserManifestId','parserDigest',
      'extractionVersion','excerptSha256','excerptByteLength','startByte','endByteExclusive',
      'pageIndex'])='{}'::jsonb
    AND artifact_id IS NOT NULL
    AND artifact_sha256 ~ '^[a-f0-9]{64}$'
    AND canonical_text_sha256 ~ '^[a-f0-9]{64}$'
    AND parser_manifest_id IS NOT NULL
    AND parser_digest ~ '^[a-f0-9]{64}$'
    AND extraction_version IN ('canonical-text/plain-utf8/1','canonical-text/pdf-pages-utf8/1','canonical-text/docx-pages-utf8/1')
    AND (locator->>'startByte') ~ '^[0-9]+$'
    AND (locator->>'endByteExclusive') ~ '^[0-9]+$'
    AND (locator->>'excerptByteLength') ~ '^[0-9]+$'
    AND (locator->>'endByteExclusive')::bigint>(locator->>'startByte')::bigint
    AND (locator->>'endByteExclusive')::bigint-(locator->>'startByte')::bigint=octet_length(excerpt_bytes)
    AND (
      (locator->>'kind'='canonical_text_span' AND NOT (locator ? 'pageIndex')
        AND extraction_version='canonical-text/plain-utf8/1')
      OR
      (locator->>'kind'='canonical_page_span' AND (locator->>'pageIndex') ~ '^[0-9]+$'
        AND extraction_version IN ('canonical-text/pdf-pages-utf8/1','canonical-text/docx-pages-utf8/1'))
    )
  ),
  ADD CONSTRAINT gate_a_live_evidence_task_input_fk
    FOREIGN KEY (tenant_id,business_task_id,document_snapshot_id,artifact_id,artifact_sha256,
      parser_manifest_id,parser_digest,extraction_version,canonical_text_sha256)
    REFERENCES business_tasks(
      tenant_id,id,input_document_snapshot_id,input_artifact_id,input_artifact_sha256,
      input_parser_manifest_id,input_parser_digest,input_extraction_version,input_canonical_text_sha256);

ALTER TABLE gate_a_live_reports
  ADD CONSTRAINT gate_a_live_reports_result_tuple_fk
    FOREIGN KEY (tenant_id,business_task_id,model_invocation_id,result_sha256)
    REFERENCES gate_a_live_results(tenant_id,business_task_id,model_invocation_id,result_sha256),
  ADD CONSTRAINT gate_a_live_reports_invocation_authority_fk
    FOREIGN KEY (tenant_id,business_task_id,model_invocation_id,workflow_version_id,workflow_hash)
    REFERENCES gate_a_model_invocations(
      tenant_id,business_task_id,id,workflow_version_id,workflow_hash);

ALTER TABLE parser_manifests
  ADD COLUMN manifest_digest_algorithm text GENERATED ALWAYS AS ('sha256-rfc8785-jcs/1') STORED;

CREATE OR REPLACE FUNCTION ensure_gate_a_parser_manifest_authority() RETURNS trigger AS $$
DECLARE dependency jsonb;
BEGIN
  IF NEW.schema_version='parser-manifest.gate-a/1' THEN
  IF NOT (NEW.canonical_manifest ?& ARRAY[
      'schemaVersion','id','mediaType','parser','dependencies','conversionConfig',
      'resourceLimitsVersion','approvedBy','approvedAt','expiresAt','manifestDigest'
    ])
    OR (NEW.canonical_manifest - ARRAY[
      'schemaVersion','id','mediaType','parser','dependencies','conversionConfig',
      'resourceLimitsVersion','approvedBy','approvedAt','expiresAt','manifestDigest'
    ])<>'{}'::jsonb
    OR NEW.canonical_manifest->>'schemaVersion' IS DISTINCT FROM NEW.schema_version
    OR NEW.canonical_manifest->>'id' IS DISTINCT FROM NEW.id
    OR NEW.canonical_manifest->>'mediaType' IS DISTINCT FROM NEW.media_type
    OR NEW.canonical_manifest->'dependencies' IS DISTINCT FROM NEW.dependencies
    OR NEW.canonical_manifest->'conversionConfig' IS DISTINCT FROM NEW.conversion_config
    OR NEW.canonical_manifest->>'resourceLimitsVersion' IS DISTINCT FROM 'gate-a-parser-limits/1'
    OR NEW.canonical_manifest->>'approvedBy' IS DISTINCT FROM NEW.approved_by
    OR (NEW.canonical_manifest->>'approvedAt')::timestamptz IS DISTINCT FROM NEW.approved_at
    OR (NEW.canonical_manifest->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
    OR NEW.canonical_manifest->>'manifestDigest' IS DISTINCT FROM NEW.manifest_digest THEN
    RAISE EXCEPTION 'ParserManifest canonical envelope does not match immutable mirror columns';
  END IF;

  IF jsonb_typeof(NEW.canonical_manifest->'parser') IS DISTINCT FROM 'object'
    OR NOT ((NEW.canonical_manifest->'parser') ?& ARRAY[
      'name','version','registrySource','upstreamSource','lockResolution','lockIntegrity',
      'executableDigest','packageDigest','license'
    ])
    OR ((NEW.canonical_manifest->'parser') - ARRAY[
      'name','version','registrySource','upstreamSource','lockResolution','lockIntegrity',
      'executableDigest','packageDigest','license'
    ])<>'{}'::jsonb
    OR NEW.canonical_manifest->'parser'->>'name' IS DISTINCT FROM NEW.parser_name
    OR NEW.canonical_manifest->'parser'->>'version' IS DISTINCT FROM NEW.parser_version
    OR NEW.canonical_manifest->'parser'->>'registrySource' IS DISTINCT FROM NEW.registry_source
    OR NEW.canonical_manifest->'parser'->>'upstreamSource' IS DISTINCT FROM NEW.upstream_source
    OR NEW.canonical_manifest->'parser'->>'lockResolution' IS DISTINCT FROM NEW.lock_resolution
    OR NEW.canonical_manifest->'parser'->>'lockIntegrity' IS DISTINCT FROM NEW.lock_integrity
    OR NEW.canonical_manifest->'parser'->>'executableDigest' IS DISTINCT FROM NEW.executable_digest
    OR NEW.canonical_manifest->'parser'->>'packageDigest' IS DISTINCT FROM NEW.package_digest
    OR NEW.canonical_manifest->'parser'->>'license' IS DISTINCT FROM NEW.license THEN
    RAISE EXCEPTION 'ParserManifest parser authority does not match immutable mirror columns';
  END IF;

  IF NOT (NEW.conversion_config ?& ARRAY[
      'inputEncoding','outputEncoding','unicodeNormalization','newlineNormalization',
      'stripByteOrderMark','maxInputBytes','maxOutputBytes'
    ])
    OR (NEW.conversion_config - ARRAY[
      'inputEncoding','outputEncoding','unicodeNormalization','newlineNormalization',
      'stripByteOrderMark','maxInputBytes','maxOutputBytes'
    ])<>'{}'::jsonb
    OR NEW.conversion_config->>'inputEncoding' IS DISTINCT FROM 'UTF-8'
    OR NEW.conversion_config->>'outputEncoding' IS DISTINCT FROM 'UTF-8'
    OR NEW.conversion_config->>'unicodeNormalization' IS DISTINCT FROM 'none'
    OR NEW.conversion_config->>'newlineNormalization' IS DISTINCT FROM 'none'
    OR NEW.conversion_config->>'stripByteOrderMark' IS DISTINCT FROM 'false'
    OR (NEW.conversion_config->>'maxInputBytes')::bigint IS DISTINCT FROM 1048576
    OR (NEW.conversion_config->>'maxOutputBytes')::bigint IS DISTINCT FROM 1048576 THEN
    RAISE EXCEPTION 'ParserManifest conversion config is not the unique allowed text/plain config';
  END IF;

  FOR dependency IN SELECT value FROM jsonb_array_elements(NEW.dependencies)
  LOOP
    IF NOT (dependency ?& ARRAY[
        'name','version','registrySource','upstreamSource','lockResolution','lockIntegrity',
        'packageDigest','license'
      ])
      OR (dependency - ARRAY[
        'name','version','registrySource','upstreamSource','lockResolution','lockIntegrity',
        'packageDigest','license'
      ])<>'{}'::jsonb
      OR dependency->>'lockIntegrity' !~ '^[a-f0-9]{64}$'
      OR dependency->>'packageDigest' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'ParserManifest dependency authority has an invalid or unknown field';
    END IF;
  END LOOP;
  ELSE
    IF NEW.schema_version IS DISTINCT FROM 'parser-manifest.gate-a/2'
      OR NEW.parser_name IS DISTINCT FROM 'geneway-document-parser'
      OR NEW.parser_version IS DISTINCT FROM '1.0.0-candidate.1'
      OR NEW.canonical_manifest->>'schemaVersion' IS DISTINCT FROM NEW.schema_version
      OR NEW.canonical_manifest->>'id' IS DISTINCT FROM NEW.id
      OR NEW.canonical_manifest->>'mediaType' IS DISTINCT FROM NEW.media_type
      OR NEW.canonical_manifest->'parser'->>'name' IS DISTINCT FROM NEW.parser_name
      OR NEW.canonical_manifest->'parser'->>'version' IS DISTINCT FROM NEW.parser_version
      OR NEW.canonical_manifest->'parser'->>'executableDigest' IS DISTINCT FROM NEW.executable_digest
      OR NEW.canonical_manifest->'parser'->>'packageDigest' IS DISTINCT FROM NEW.package_digest
      OR NEW.canonical_manifest->'parser'->>'imageDigest' IS DISTINCT FROM NEW.canonical_manifest->>'approvedImageId'
      OR NEW.canonical_manifest->>'approvedPackageDigest' IS DISTINCT FROM NEW.package_digest
      OR NEW.canonical_manifest->>'runtimeClosureDigest' IS DISTINCT FROM NEW.canonical_manifest->>'approvedRuntimeClosureDigest'
      OR NEW.canonical_manifest->'dependencies' IS DISTINCT FROM NEW.dependencies
      OR NEW.canonical_manifest->'conversionConfig' IS DISTINCT FROM NEW.conversion_config
      OR NEW.canonical_manifest->>'manifestDigest' IS DISTINCT FROM NEW.manifest_digest
      OR NEW.canonical_manifest->>'approvedBy' IS DISTINCT FROM NEW.approved_by
      OR (NEW.canonical_manifest->>'approvedAt')::timestamptz IS DISTINCT FROM NEW.approved_at
      OR (NEW.canonical_manifest->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
      OR jsonb_array_length(NEW.dependencies) IS DISTINCT FROM 5
      OR (SELECT jsonb_agg(value->>'name') FROM jsonb_array_elements(NEW.dependencies))
        IS DISTINCT FROM '["node","libc6","libstdc++6","libgcc-s1","pdfjs-dist"]'::jsonb THEN
      RAISE EXCEPTION 'ParserManifest v2 runtime and approval authority do not match immutable mirrors';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS parser_manifests_authority_guard ON parser_manifests;
CREATE TRIGGER parser_manifests_authority_guard
  BEFORE INSERT OR UPDATE ON parser_manifests
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_parser_manifest_authority();

DROP TRIGGER IF EXISTS workflow_template_versions_immutable ON workflow_template_versions;
CREATE TRIGGER workflow_template_versions_immutable BEFORE UPDATE OR DELETE ON workflow_template_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS parser_manifests_immutable ON parser_manifests;
CREATE TRIGGER parser_manifests_immutable BEFORE UPDATE OR DELETE ON parser_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS document_snapshot_canonical_representations_immutable
  ON document_snapshot_canonical_representations;
CREATE TRIGGER document_snapshot_canonical_representations_immutable
  BEFORE UPDATE OR DELETE ON document_snapshot_canonical_representations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS gate_a_classified_document_sources_immutable
  ON gate_a_classified_document_sources;
CREATE TRIGGER gate_a_classified_document_sources_immutable
  BEFORE UPDATE OR DELETE ON gate_a_classified_document_sources
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS deidentification_reclassification_records_immutable
  ON deidentification_reclassification_records;
CREATE TRIGGER deidentification_reclassification_records_immutable
  BEFORE UPDATE OR DELETE ON deidentification_reclassification_records
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS gate_a_reclassification_revocations_immutable
  ON gate_a_reclassification_revocations;
CREATE TRIGGER gate_a_reclassification_revocations_immutable
  BEFORE UPDATE OR DELETE ON gate_a_reclassification_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS gate_a_live_results_immutable ON gate_a_live_results;
CREATE OR REPLACE FUNCTION allow_gate_a_staged_publication_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Gate A staged publication rows cannot be deleted';
  END IF;
  IF OLD.publication_state='staging' AND NEW.publication_state='published' THEN
    IF TG_TABLE_NAME='gate_a_live_evidence' THEN
      IF OLD.accessible OR NOT NEW.accessible
        OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.id IS DISTINCT FROM NEW.id
        OR OLD.business_task_id IS DISTINCT FROM NEW.business_task_id
        OR OLD.record_variant IS DISTINCT FROM NEW.record_variant
        OR OLD.document_snapshot_id IS DISTINCT FROM NEW.document_snapshot_id
        OR OLD.locator IS DISTINCT FROM NEW.locator
        OR OLD.excerpt_bytes IS DISTINCT FROM NEW.excerpt_bytes
        OR OLD.excerpt_sha256 IS DISTINCT FROM NEW.excerpt_sha256
        OR OLD.resource_scope IS DISTINCT FROM NEW.resource_scope
        OR OLD.data_class IS DISTINCT FROM NEW.data_class
        OR OLD.audience IS DISTINCT FROM NEW.audience
        OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'Gate A Evidence publication may only expose immutable staged bytes';
      END IF;
    ELSIF (to_jsonb(OLD)-'publication_state')
      IS DISTINCT FROM (to_jsonb(NEW)-'publication_state') THEN
      RAISE EXCEPTION 'Gate A publication may only expose an immutable staged row';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Gate A published rows are immutable and publication is one-way';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER gate_a_live_results_immutable BEFORE UPDATE OR DELETE ON gate_a_live_results
  FOR EACH ROW EXECUTE FUNCTION allow_gate_a_staged_publication_only();
CREATE OR REPLACE FUNCTION ensure_gate_a_live_evidence_bytes() RETURNS trigger AS $$
DECLARE
  canonical_bytes_value bytea;
  canonical_page_index_value jsonb;
  page_entry jsonb;
  start_byte integer;
  end_byte integer;
BEGIN
  SELECT canonical_bytes,canonical_page_index
    INTO canonical_bytes_value,canonical_page_index_value
    FROM document_snapshot_canonical_representations
   WHERE tenant_id=NEW.tenant_id
     AND document_snapshot_id=NEW.document_snapshot_id
     AND parser_manifest_id=NEW.locator->>'parserManifestId'
     AND parser_digest=NEW.locator->>'parserDigest'
     AND extraction_version=NEW.locator->>'extractionVersion'
     AND canonical_text_sha256=NEW.locator->>'canonicalTextSha256';

  IF canonical_bytes_value IS NULL THEN
    RAISE EXCEPTION 'Evidence locator canonical authority is unavailable or drifted';
  END IF;
  start_byte := (NEW.locator->>'startByte')::integer;
  end_byte := (NEW.locator->>'endByteExclusive')::integer;
  IF NEW.locator->>'kind'='canonical_page_span' THEN
    IF jsonb_typeof(canonical_page_index_value) IS DISTINCT FROM 'object'
      OR canonical_page_index_value->>'schemaVersion' IS DISTINCT FROM 'canonical-page-index/1'
      OR jsonb_typeof(canonical_page_index_value->'pages') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'page Evidence requires an immutable canonical page index';
    END IF;
    SELECT value INTO page_entry
      FROM jsonb_array_elements(canonical_page_index_value->'pages')
     WHERE (value->>'pageIndex')::bigint=(NEW.locator->>'pageIndex')::bigint
     LIMIT 1;
    IF page_entry IS NULL
      OR end_byte>(page_entry->>'canonicalEndByteExclusive')::bigint-(page_entry->>'canonicalStartByte')::bigint THEN
      RAISE EXCEPTION 'page Evidence span is outside its immutable canonical page';
    END IF;
    IF substring(canonical_bytes_value
        FROM (page_entry->>'canonicalStartByte')::integer+start_byte+1 FOR end_byte-start_byte)
      IS DISTINCT FROM NEW.excerpt_bytes OR convert_from(NEW.excerpt_bytes,'UTF8') IS NULL THEN
      RAISE EXCEPTION 'page Evidence excerpt is not the exact page-relative UTF-8 canonical byte slice';
    END IF;
  ELSIF end_byte>octet_length(canonical_bytes_value)
    OR substring(canonical_bytes_value FROM start_byte+1 FOR end_byte-start_byte)
      IS DISTINCT FROM NEW.excerpt_bytes
    OR convert_from(NEW.excerpt_bytes,'UTF8') IS NULL THEN
    RAISE EXCEPTION 'Evidence excerpt is not the exact UTF-8 canonical byte slice';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gate_a_live_evidence_bytes_guard ON gate_a_live_evidence;
CREATE CONSTRAINT TRIGGER gate_a_live_evidence_bytes_guard
  AFTER INSERT ON gate_a_live_evidence DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_live_evidence_bytes();

DROP TRIGGER IF EXISTS gate_a_live_evidence_immutable ON gate_a_live_evidence;
CREATE TRIGGER gate_a_live_evidence_immutable BEFORE UPDATE OR DELETE ON gate_a_live_evidence
  FOR EACH ROW EXECUTE FUNCTION allow_gate_a_staged_publication_only();
DROP TRIGGER IF EXISTS gate_a_live_claims_immutable ON gate_a_live_claims;
CREATE TRIGGER gate_a_live_claims_immutable BEFORE UPDATE OR DELETE ON gate_a_live_claims
  FOR EACH ROW EXECUTE FUNCTION allow_gate_a_staged_publication_only();
DROP TRIGGER IF EXISTS gate_a_live_evidence_links_immutable ON gate_a_live_evidence_links;
CREATE TRIGGER gate_a_live_evidence_links_immutable BEFORE UPDATE OR DELETE ON gate_a_live_evidence_links
  FOR EACH ROW EXECUTE FUNCTION allow_gate_a_staged_publication_only();
DROP TRIGGER IF EXISTS gate_a_live_reports_immutable ON gate_a_live_reports;
CREATE TRIGGER gate_a_live_reports_immutable BEFORE UPDATE OR DELETE ON gate_a_live_reports
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

ALTER TABLE gate_a_model_invocations
  ADD COLUMN gateway_receipt_jti uuid,
  ADD COLUMN gateway_receipt_digest text
    CHECK (gateway_receipt_digest IS NULL OR gateway_receipt_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN gateway_receipt_signature text
    CHECK (gateway_receipt_signature IS NULL OR gateway_receipt_signature ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN receipt_attested boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT gate_a_model_invocations_receipt_terminal_check CHECK (
    (status IN ('pending','running','cancel_requested')
      AND NOT receipt_attested
      AND gateway_receipt_jti IS NULL
      AND gateway_receipt_digest IS NULL
      AND gateway_receipt_signature IS NULL)
    OR
    (status='completed'
      AND receipt_attested
      AND gateway_receipt_jti IS NOT NULL
      AND gateway_receipt_digest IS NOT NULL
      AND gateway_receipt_signature IS NOT NULL)
    OR
    (status='failed' AND (
      (NOT receipt_attested
        AND gateway_receipt_jti IS NULL
        AND gateway_receipt_digest IS NULL
        AND gateway_receipt_signature IS NULL)
      OR
      (receipt_attested
        AND gateway_receipt_jti IS NOT NULL
        AND gateway_receipt_digest IS NOT NULL
        AND gateway_receipt_signature IS NOT NULL)
    ))
    OR
    (status='canceled'
      AND NOT receipt_attested
      AND gateway_receipt_jti IS NULL
      AND gateway_receipt_digest IS NULL
      AND gateway_receipt_signature IS NULL)
  );

CREATE UNIQUE INDEX gate_a_model_invocations_receipt_jti_uq
  ON gate_a_model_invocations(tenant_id,gateway_receipt_jti)
  WHERE gateway_receipt_jti IS NOT NULL;

ALTER TABLE gate_a_model_invocations
  ADD CONSTRAINT gate_a_model_invocations_report_authority_tuple_uq UNIQUE (
    tenant_id,business_task_id,id,execution_attempt_id,task_fence,step_fence,
    workflow_version_id,workflow_hash,approval_subject_digest,document_snapshot_id,
    artifact_id,artifact_sha256,canonical_text_sha256,parser_manifest_id,parser_digest,
    extraction_version,resource_scope
  );

CREATE TABLE gate_a_live_report_publish_intents (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
  workflow_version_id text NOT NULL,
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[a-f0-9]{64}$'),
  approval_subject_digest text NOT NULL CHECK (approval_subject_digest ~ '^[a-f0-9]{64}$'),
  model_invocation_id text NOT NULL,
  execution_attempt_id text NOT NULL,
  task_fence bigint NOT NULL CHECK (task_fence>0),
  step_fence bigint NOT NULL CHECK (step_fence>0),
  document_snapshot_id text NOT NULL,
  source_artifact_id text NOT NULL,
  source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_text_sha256 text NOT NULL CHECK (canonical_text_sha256 ~ '^[a-f0-9]{64}$'),
  parser_manifest_id text NOT NULL,
  parser_digest text NOT NULL CHECK (parser_digest ~ '^[a-f0-9]{64}$'),
  extraction_version text NOT NULL CHECK (extraction_version IN ('canonical-text/plain-utf8/1','canonical-text/pdf-pages-utf8/1','canonical-text/docx-pages-utf8/1')),
  root_artifact_id text NOT NULL,
  conversation_id text NOT NULL,
  owner_user_id text NOT NULL,
  resource_scope text NOT NULL,
  data_class text NOT NULL CHECK (data_class='C1'),
  audience text NOT NULL,
  artifact_id text NOT NULL,
  manifest_id text NOT NULL,
  storage_bucket text NOT NULL CHECK (length(storage_bucket) BETWEEN 1 AND 200),
  storage_key text NOT NULL CHECK (
    length(storage_key) BETWEEN 1 AND 512
    AND storage_key !~ '(^|/)\.\.(/|$)'
    AND storage_key !~ '[\\\x00]'
  ),
  renderer_version text NOT NULL CHECK (renderer_version='analysis-report-renderer/1'),
  render_input_sha256 text NOT NULL CHECK (render_input_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN (
    'prepared','put_inflight','object_verified','published',
    'reconcile_required','integrity_error','put_failed_confirmed','canceled'
  )),
  state_version bigint NOT NULL CHECK (state_version>0),
  etag_observed text,
  failure_code text,
  object_verified_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id),
  UNIQUE (tenant_id,artifact_id),
  UNIQUE (tenant_id,manifest_id),
  UNIQUE (tenant_id,storage_bucket,storage_key),
  FOREIGN KEY (tenant_id,business_task_id,model_invocation_id,result_sha256)
    REFERENCES gate_a_live_results(tenant_id,business_task_id,model_invocation_id,result_sha256),
  FOREIGN KEY (
    tenant_id,business_task_id,model_invocation_id,execution_attempt_id,task_fence,step_fence,
    workflow_version_id,workflow_hash,approval_subject_digest,document_snapshot_id,
    source_artifact_id,source_artifact_sha256,canonical_text_sha256,parser_manifest_id,
    parser_digest,extraction_version,resource_scope
  ) REFERENCES gate_a_model_invocations(
    tenant_id,business_task_id,id,execution_attempt_id,task_fence,step_fence,
    workflow_version_id,workflow_hash,approval_subject_digest,document_snapshot_id,
    artifact_id,artifact_sha256,canonical_text_sha256,parser_manifest_id,parser_digest,
    extraction_version,resource_scope
  ),
  FOREIGN KEY (tenant_id,execution_attempt_id,business_task_id)
    REFERENCES execution_attempts(tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,business_task_id,conversation_id,owner_user_id)
    REFERENCES business_tasks(tenant_id,id,conversation_id,requester_id),
  FOREIGN KEY (tenant_id,source_artifact_id,source_artifact_sha256)
    REFERENCES artifacts(tenant_id,id,content_sha256),
  FOREIGN KEY (tenant_id,document_snapshot_id,source_artifact_id,source_artifact_sha256)
    REFERENCES document_snapshots(tenant_id,id,artifact_id,content_sha256),
  FOREIGN KEY (
    tenant_id,document_snapshot_id,parser_manifest_id,parser_digest,extraction_version,
    canonical_text_sha256
  ) REFERENCES document_snapshot_canonical_representations(
    tenant_id,document_snapshot_id,parser_manifest_id,parser_digest,extraction_version,
    canonical_text_sha256
  ),
  CHECK (root_artifact_id=source_artifact_id),
  CHECK (resource_scope='artifact:' || root_artifact_id),
  CHECK (audience='conversation:' || conversation_id),
  CHECK (
    (status IN ('prepared','put_inflight','reconcile_required','put_failed_confirmed')
      AND object_verified_at IS NULL AND published_at IS NULL)
    OR
    (status IN ('object_verified','integrity_error','canceled')
      AND published_at IS NULL)
    OR
    (status='published'
      AND object_verified_at IS NOT NULL AND published_at IS NOT NULL AND etag_observed IS NOT NULL)
  ),
  CHECK (
    (status IN ('prepared','put_inflight','object_verified','published') AND failure_code IS NULL)
    OR
    (status IN ('reconcile_required','integrity_error','put_failed_confirmed','canceled') AND failure_code IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION ensure_gate_a_live_report_publish_intent_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Gate A live report publish intents cannot be deleted';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'prepared'
      OR NEW.state_version IS DISTINCT FROM 1
      OR NEW.etag_observed IS NOT NULL
      OR NEW.failure_code IS NOT NULL
      OR NEW.object_verified_at IS NOT NULL
      OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'Gate A live report publish intent must start prepared at version 1';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status='published' THEN
    RAISE EXCEPTION 'published Gate A live report authority is immutable';
  END IF;
  IF NEW.state_version IS DISTINCT FROM OLD.state_version+1 THEN
    RAISE EXCEPTION 'Gate A live report publish intent state_version must advance by one';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.business_task_id IS DISTINCT FROM OLD.business_task_id
    OR NEW.result_sha256 IS DISTINCT FROM OLD.result_sha256
    OR NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id
    OR NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash
    OR NEW.approval_subject_digest IS DISTINCT FROM OLD.approval_subject_digest
    OR NEW.model_invocation_id IS DISTINCT FROM OLD.model_invocation_id
    OR NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
    OR NEW.task_fence IS DISTINCT FROM OLD.task_fence
    OR NEW.step_fence IS DISTINCT FROM OLD.step_fence
    OR NEW.document_snapshot_id IS DISTINCT FROM OLD.document_snapshot_id
    OR NEW.source_artifact_id IS DISTINCT FROM OLD.source_artifact_id
    OR NEW.source_artifact_sha256 IS DISTINCT FROM OLD.source_artifact_sha256
    OR NEW.canonical_text_sha256 IS DISTINCT FROM OLD.canonical_text_sha256
    OR NEW.parser_manifest_id IS DISTINCT FROM OLD.parser_manifest_id
    OR NEW.parser_digest IS DISTINCT FROM OLD.parser_digest
    OR NEW.extraction_version IS DISTINCT FROM OLD.extraction_version
    OR NEW.root_artifact_id IS DISTINCT FROM OLD.root_artifact_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.resource_scope IS DISTINCT FROM OLD.resource_scope
    OR NEW.data_class IS DISTINCT FROM OLD.data_class
    OR NEW.audience IS DISTINCT FROM OLD.audience
    OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
    OR NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
    OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.renderer_version IS DISTINCT FROM OLD.renderer_version
    OR NEW.render_input_sha256 IS DISTINCT FROM OLD.render_input_sha256
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Gate A live report publish immutable authority drifted';
  END IF;

  IF NOT (
    (OLD.status='prepared' AND NEW.status IN (
      'put_inflight','object_verified','reconcile_required','put_failed_confirmed','integrity_error','canceled'
    ))
    OR (OLD.status='put_inflight' AND NEW.status IN (
      'object_verified','reconcile_required','put_failed_confirmed','integrity_error','canceled'
    ))
    OR (OLD.status='reconcile_required' AND NEW.status IN (
      'put_inflight','object_verified','put_failed_confirmed','integrity_error','canceled'
    ))
    OR (OLD.status='put_failed_confirmed' AND NEW.status IN (
      'prepared','put_inflight','reconcile_required','integrity_error','canceled'
    ))
    OR (OLD.status='object_verified' AND NEW.status IN ('published','integrity_error','canceled'))
  ) THEN
    RAISE EXCEPTION 'invalid Gate A live report publish intent transition';
  END IF;

  NEW.updated_at := now();
  IF NEW.status='object_verified' AND NEW.object_verified_at IS NULL THEN
    NEW.object_verified_at := now();
  END IF;
  IF NEW.status='published' AND NEW.published_at IS NULL THEN
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gate_a_live_report_publish_intents_transition_guard
  BEFORE INSERT OR UPDATE OR DELETE ON gate_a_live_report_publish_intents
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_live_report_publish_intent_transition();

CREATE OR REPLACE FUNCTION ensure_gate_a_live_report_published_authority() RETURNS trigger AS $$
BEGIN
  IF NEW.status='published' AND NOT EXISTS (
    SELECT 1
      FROM gate_a_model_invocations invocation
      JOIN gate_a_live_reports report
        ON report.tenant_id=invocation.tenant_id
       AND report.business_task_id=invocation.business_task_id
       AND report.model_invocation_id=invocation.id
       AND report.workflow_version_id=invocation.workflow_version_id
       AND report.workflow_hash=invocation.workflow_hash
      JOIN execution_attempts execution
        ON execution.tenant_id=invocation.tenant_id
       AND execution.id=invocation.execution_attempt_id
      JOIN business_tasks task
        ON task.tenant_id=invocation.tenant_id
       AND task.id=invocation.business_task_id
      JOIN business_task_steps analysis_step
        ON analysis_step.tenant_id=invocation.tenant_id
       AND analysis_step.business_task_id=invocation.business_task_id
       AND analysis_step.step_id=invocation.step_id
      JOIN business_task_steps report_publish_step
        ON report_publish_step.tenant_id=invocation.tenant_id
       AND report_publish_step.business_task_id=invocation.business_task_id
       AND report_publish_step.step_id='report_publish'
      JOIN gate_a_live_results result
        ON result.tenant_id=invocation.tenant_id
       AND result.business_task_id=invocation.business_task_id
       AND result.model_invocation_id=invocation.id
      JOIN artifacts artifact
        ON artifact.tenant_id=report.tenant_id AND artifact.id=report.artifact_id
      JOIN artifact_manifests manifest
        ON manifest.tenant_id=artifact.tenant_id AND manifest.artifact_id=artifact.id
      JOIN artifact_states state
        ON state.tenant_id=artifact.tenant_id AND state.artifact_id=artifact.id
     WHERE invocation.tenant_id=NEW.tenant_id
       AND invocation.business_task_id=NEW.business_task_id
       AND invocation.id=NEW.model_invocation_id
       AND invocation.status='completed'
       AND invocation.step_id='solution_design'
       AND execution.business_task_id=NEW.business_task_id
       AND execution.status='completed'
       AND execution.fencing_token=NEW.task_fence
       AND task.record_variant='business-task.live/1'
       AND NOT task.simulation
       AND task.runtime_mode='model_gateway'
       AND NOT task.business_decision_allowed
       AND task.status='completed'
       AND task.result_record_variant='business-task-result.live/1'
       AND task.result IS NOT NULL
       AND task.result IS NOT DISTINCT FROM result.result
       AND task.current_execution_attempt_id=execution.id
       AND task.execution_version=execution.execution_version
       AND task.execution_fencing_token=execution.fencing_token
       AND analysis_step.record_variant='business-task-step.live/1'
       AND NOT analysis_step.simulation
       AND analysis_step.runtime_mode='model_gateway'
       AND NOT analysis_step.business_decision_allowed
       AND analysis_step.status='completed'
       AND analysis_step.attempt_id=invocation.step_attempt_id
       AND analysis_step.fencing_token=NEW.step_fence
       AND report_publish_step.record_variant='business-task-step.live/1'
       AND NOT report_publish_step.simulation
       AND report_publish_step.runtime_mode='model_gateway'
       AND NOT report_publish_step.business_decision_allowed
       AND report_publish_step.status='completed'
       AND result.record_variant='business-task-result.live/1'
       AND result.result_sha256=NEW.result_sha256
       AND report.artifact_id=NEW.artifact_id
       AND report.result_sha256=NEW.result_sha256
       AND artifact.kind='analysis_report'
       AND artifact.record_variant='artifact.analysis-report.live/1'
       AND artifact.content_sha256=NEW.content_sha256
       AND artifact.size_bytes=NEW.size_bytes
       AND artifact.data_class='C1'
       AND artifact.audience=jsonb_build_object(
         'kind', 'private-conversation',
         'conversationId', NEW.conversation_id
       )
       AND artifact.conversation_id=NEW.conversation_id
       AND artifact.owner_user_id=NEW.owner_user_id
       AND artifact.root_artifact_id=NEW.root_artifact_id
       AND artifact.resource_scope=NEW.resource_scope
       AND manifest.id=NEW.manifest_id
       AND manifest.storage_bucket=NEW.storage_bucket
       AND manifest.storage_key=NEW.storage_key
       AND manifest.content_sha256=NEW.content_sha256
       AND manifest.size_bytes=NEW.size_bytes
       AND state.availability='active'
       AND state.integrity='verified'
       AND state.retention_status='active'
       AND state.retention_expires_at>now()
       AND state.reconcile_status='in_sync'
       AND state.etag_observed IS NOT DISTINCT FROM NEW.etag_observed
  ) THEN
    RAISE EXCEPTION 'published Gate A live report lacks exact finalized authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER gate_a_live_report_published_authority_guard
  AFTER INSERT OR UPDATE ON gate_a_live_report_publish_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_live_report_published_authority();

DROP TRIGGER IF EXISTS gate_a_live_task_publication_terminal_guard ON business_tasks;
CREATE CONSTRAINT TRIGGER gate_a_live_task_publication_terminal_guard
  AFTER INSERT OR UPDATE ON business_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_live_task_publication_terminal();
