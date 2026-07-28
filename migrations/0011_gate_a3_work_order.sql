-- Gate A A.3: additive single-Work-Order authority. Historical simulation and
-- live-material rows remain unchanged; every A.3 relation carries its own
-- discriminator and is bound to the approved immutable ConnectorQuerySpec.

ALTER TABLE business_tasks DROP CONSTRAINT IF EXISTS business_tasks_gate_a_terminal_error_check;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_gate_a_terminal_error_check CHECK (
  terminal_error_class IS NULL
  OR (record_variant='business-task.live/1' AND status='failed' AND terminal_error_class IN (
    'MODEL_ROUTE_UNAVAILABLE','MODEL_AUTH_FAILED','MODEL_QUOTA','MODEL_TIMEOUT',
    'MODEL_STREAM_INTERRUPTED','MODEL_PROTOCOL_VIOLATION','MODEL_BUSY','DATA_ROUTE_NOT_ALLOWED',
    'REPORT_AUTHORITY_INVALID','REPORT_PUBLICATION_FAILED','STORAGE_OPERATION_FAILED'))
  OR (record_variant='business-task.work-order.live/1' AND status='failed' AND terminal_error_class IN (
    'CONNECTOR_ROUTE_UNAVAILABLE','CONNECTOR_AUTH_FAILED','CONNECTOR_RATE_LIMITED',
    'CONNECTOR_TIMEOUT','CONNECTOR_PROTOCOL_VIOLATION','CONNECTOR_NOT_FOUND_OR_FORBIDDEN',
    'CONNECTOR_AUTHORITY_STALE','MODEL_ROUTE_UNAVAILABLE','MODEL_AUTH_FAILED',
    'MODEL_QUOTA','MODEL_TIMEOUT','MODEL_STREAM_INTERRUPTED','MODEL_PROTOCOL_VIOLATION','MODEL_BUSY',
    'WORK_ORDER_REF_INVALID','WORK_ORDER_PROTOCOL_VIOLATION'))
);

ALTER TABLE business_tasks DROP CONSTRAINT IF EXISTS business_tasks_gate_a_variant_check;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_gate_a_variant_check CHECK (
  (simulation AND runtime_mode='fake' AND NOT business_decision_allowed
    AND record_variant IS NULL AND result_record_variant IS NULL AND semantic_fingerprint IS NULL)
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND record_variant='business-task.live/1'
    AND semantic_fingerprint ~ '^[a-f0-9]{64}$'
    AND ((result IS NULL AND result_record_variant IS NULL)
      OR (result IS NOT NULL AND result_record_variant='business-task-result.live/1')))
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND record_variant='business-task.work-order.live/1'
    AND semantic_fingerprint ~ '^[a-f0-9]{64}$'
    AND ((result IS NULL AND result_record_variant IS NULL)
      OR (result IS NOT NULL AND result_record_variant='business-task-result.work-order.live/1')))
);
CREATE UNIQUE INDEX IF NOT EXISTS business_tasks_gate_a3_semantic_fingerprint_uq
  ON business_tasks(tenant_id,requester_id,semantic_fingerprint)
  WHERE record_variant='business-task.work-order.live/1';

ALTER TABLE business_tasks DROP CONSTRAINT IF EXISTS business_tasks_live_input_shape_check;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_live_input_shape_check CHECK (
  record_variant IS NULL
  OR (record_variant='business-task.live/1'
    AND input_snapshot->>'kind'='live_document_snapshot'
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
    AND input_canonical_text_sha256 ~ '^[a-f0-9]{64}$')
  OR (record_variant='business-task.work-order.live/1'
    AND input_snapshot->>'kind'='work_order'
    AND input_snapshot->>'connectorQuerySpecId' IS NOT NULL
    AND input_snapshot->>'connectorQuerySpecHash' ~ '^[a-f0-9]{64}$'
    AND input_snapshot->>'workOrderRefHash' ~ '^[a-f0-9]{64}$'
    AND input_snapshot->>'resourceContextDigest' ~ '^[a-f0-9]{64}$'
    AND input_document_snapshot_id IS NULL AND input_artifact_id IS NULL
    AND input_artifact_sha256 IS NULL AND input_parser_manifest_id IS NULL
    AND input_parser_digest IS NULL AND input_extraction_version IS NULL
    AND input_canonical_text_sha256 IS NULL)
);

ALTER TABLE business_task_events DROP CONSTRAINT IF EXISTS business_task_events_gate_a_variant_check;
ALTER TABLE business_task_events ADD CONSTRAINT business_task_events_gate_a_variant_check CHECK (
  (simulation AND runtime_mode='fake' AND NOT business_decision_allowed
    AND schema_version=1 AND record_variant IS NULL)
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND schema_version=2 AND record_variant='business-task-event.live/1')
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND schema_version=3 AND record_variant='business-task-event.work-order.live/1')
);

ALTER TABLE business_task_steps DROP CONSTRAINT IF EXISTS business_task_steps_gate_a_variant_check;
ALTER TABLE business_task_steps ADD CONSTRAINT business_task_steps_gate_a_variant_check CHECK (
  (simulation AND runtime_mode='fake' AND NOT business_decision_allowed AND record_variant IS NULL)
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND record_variant='business-task-step.live/1')
  OR
  (NOT simulation AND runtime_mode='model_gateway' AND NOT business_decision_allowed
    AND record_variant='business-task-step.work-order.live/1')
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
  ELSIF task_variant='business-task.live/1' THEN
    IF task_simulation IS DISTINCT FROM false OR task_runtime_mode IS DISTINCT FROM 'model_gateway'
      OR task_business_decision_allowed IS DISTINCT FROM false OR NEW.simulation IS DISTINCT FROM false
      OR NEW.runtime_mode IS DISTINCT FROM 'model_gateway'
      OR NEW.business_decision_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'live material task relation must use the exact live selector tuple';
    END IF;
    IF TG_TABLE_NAME='business_task_events' THEN
      IF NEW.record_variant IS DISTINCT FROM 'business-task-event.live/1'
        OR NEW.schema_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'live material task event must use the exact live selector tuple';
      END IF;
    ELSIF TG_TABLE_NAME='business_task_steps' THEN
      IF NEW.record_variant IS DISTINCT FROM 'business-task-step.live/1' THEN
        RAISE EXCEPTION 'live material task step must use the exact live selector tuple';
      END IF;
    END IF;
  ELSIF task_variant='business-task.work-order.live/1' THEN
    IF task_simulation IS DISTINCT FROM false OR task_runtime_mode IS DISTINCT FROM 'model_gateway'
      OR task_business_decision_allowed IS DISTINCT FROM false OR NEW.simulation IS DISTINCT FROM false
      OR NEW.runtime_mode IS DISTINCT FROM 'model_gateway'
      OR NEW.business_decision_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'live Work Order task relation must use the exact live selector tuple';
    END IF;
    IF TG_TABLE_NAME='business_task_events' THEN
      IF NEW.record_variant IS DISTINCT FROM 'business-task-event.work-order.live/1'
        OR NEW.schema_version IS DISTINCT FROM 3 THEN
        RAISE EXCEPTION 'live Work Order task event must use the exact live selector tuple';
      END IF;
    ELSIF TG_TABLE_NAME='business_task_steps' THEN
      IF NEW.record_variant IS DISTINCT FROM 'business-task-step.work-order.live/1' THEN
        RAISE EXCEPTION 'live Work Order task step must use the exact live selector tuple';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'task root has an invalid selector tuple';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE gate_a3_connector_query_specs (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  business_task_id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version='connector-query-spec/1'),
  canonicalization_version text NOT NULL CHECK (canonicalization_version='RFC8785/JCS-1'),
  capability_version_id text NOT NULL,
  release_record_id text NOT NULL,
  approved_preflight_digest text NOT NULL CHECK (approved_preflight_digest ~ '^[a-f0-9]{64}$'),
  connector_profile_version text NOT NULL,
  base_url text NOT NULL,
  endpoint_path text NOT NULL,
  method text NOT NULL CHECK (method='GET'),
  endpoint_method_allowlist_digest text NOT NULL CHECK (endpoint_method_allowlist_digest ~ '^[a-f0-9]{64}$'),
  field_mask_version text NOT NULL,
  field_mask_digest text NOT NULL CHECK (field_mask_digest ~ '^[a-f0-9]{64}$'),
  work_order_ref text NOT NULL CHECK (work_order_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  work_order_ref_hash text NOT NULL CHECK (work_order_ref_hash ~ '^[a-f0-9]{64}$'),
  principal_id text NOT NULL,
  resource_context_digest text NOT NULL CHECK (resource_context_digest ~ '^[a-f0-9]{64}$'),
  workflow_version_id text NOT NULL,
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[a-f0-9]{64}$'),
  step_id text NOT NULL CHECK (step_id='fetch_authorized_status'),
  budget jsonb NOT NULL CHECK (jsonb_typeof(budget)='object'),
  deadline timestamptz NOT NULL,
  public_error_policy jsonb NOT NULL CHECK (jsonb_typeof(public_error_policy)='object'),
  card_schema_version text NOT NULL CHECK (card_schema_version='WorkOrderStatusCard/1'),
  canonical_spec jsonb NOT NULL CHECK (jsonb_typeof(canonical_spec)='object'),
  spec_hash text NOT NULL CHECK (spec_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id),
  UNIQUE (tenant_id,spec_hash),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,capability_version_id) REFERENCES capability_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,release_record_id) REFERENCES capability_release_records(tenant_id,id),
  FOREIGN KEY (tenant_id,workflow_version_id,workflow_hash)
    REFERENCES workflow_versions(tenant_id,id,workflow_hash),
  CHECK (canonical_spec->>'schemaVersion'=schema_version),
  CHECK (canonical_spec->>'canonicalizationVersion'=canonicalization_version),
  CHECK (canonical_spec->>'workOrderRef'=work_order_ref),
  CHECK (canonical_spec->>'connectorProfileVersion'=connector_profile_version),
  CHECK (canonical_spec->>'fieldMaskVersion'=field_mask_version),
  CHECK (deadline>created_at)
);
CREATE TRIGGER gate_a3_connector_query_specs_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_connector_query_specs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE TABLE gate_a3_connector_invocations (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  connector_query_spec_id text NOT NULL,
  connector_query_spec_hash text NOT NULL CHECK (connector_query_spec_hash ~ '^[a-f0-9]{64}$'),
  connector_profile_version text NOT NULL,
  work_order_ref_hash text NOT NULL CHECK (work_order_ref_hash ~ '^[a-f0-9]{64}$'),
  field_mask_version text NOT NULL,
  principal_id text NOT NULL,
  resource_context_digest text NOT NULL CHECK (resource_context_digest ~ '^[a-f0-9]{64}$'),
  workflow_version_id text NOT NULL,
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[a-f0-9]{64}$'),
  step_id text NOT NULL CHECK (step_id='fetch_authorized_status'),
  execution_attempt_id text NOT NULL,
  step_attempt_id text NOT NULL,
  effect_id text NOT NULL,
  task_fence bigint NOT NULL CHECK (task_fence>0),
  step_fence bigint NOT NULL CHECK (step_fence>0),
  jti_digest text NOT NULL CHECK (jti_digest ~ '^[a-f0-9]{64}$'),
  deadline timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('authorized','running','completed','failed','canceled')),
  error_class text,
  response_ref_matched boolean,
  source_revision text,
  response_canonical_hash text CHECK (response_canonical_hash IS NULL OR response_canonical_hash ~ '^[a-f0-9]{64}$'),
  redacted_audit jsonb NOT NULL CHECK (jsonb_typeof(redacted_audit)='object'),
  started_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id,effect_id,step_attempt_id),
  UNIQUE (tenant_id,jti_digest),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_query_spec_id) REFERENCES gate_a3_connector_query_specs(tenant_id,id),
  CHECK ((status IN ('authorized','running') AND terminal_at IS NULL)
    OR (status IN ('completed','failed','canceled') AND terminal_at IS NOT NULL)),
  CHECK ((status='completed' AND error_class IS NULL AND response_ref_matched
      AND source_revision IS NOT NULL AND response_canonical_hash IS NOT NULL)
    OR status<>'completed')
);
CREATE INDEX gate_a3_connector_invocations_claim_idx
  ON gate_a3_connector_invocations(tenant_id,business_task_id,status,created_at);

CREATE TABLE gate_a3_connector_token_authorizations (
  tenant_id text NOT NULL,
  jti_digest text NOT NULL CHECK (jti_digest ~ '^[a-f0-9]{64}$'),
  connector_invocation_id text NOT NULL,
  business_task_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,jti_digest),
  UNIQUE (tenant_id,connector_invocation_id),
  FOREIGN KEY (tenant_id,connector_invocation_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  CHECK (expires_at>created_at),
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

CREATE TABLE gate_a3_connector_source_snapshots (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  connector_invocation_id text NOT NULL,
  connector_query_spec_id text NOT NULL,
  connector_query_spec_hash text NOT NULL CHECK (connector_query_spec_hash ~ '^[a-f0-9]{64}$'),
  execution_attempt_id text NOT NULL,
  step_attempt_id text NOT NULL,
  effect_id text NOT NULL,
  task_fence bigint NOT NULL CHECK (task_fence>0),
  step_fence bigint NOT NULL CHECK (step_fence>0),
  work_order_ref_hash text NOT NULL CHECK (work_order_ref_hash ~ '^[a-f0-9]{64}$'),
  response_ref_matched boolean NOT NULL CHECK (response_ref_matched),
  field_mask_version text NOT NULL,
  source_revision text NOT NULL,
  source_as_of timestamptz NOT NULL,
  canonical_payload jsonb NOT NULL CHECK (jsonb_typeof(canonical_payload)='object'),
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[a-f0-9]{64}$'),
  resource_scope text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('C0','C1')),
  audience text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id,effect_id),
  UNIQUE (tenant_id,connector_invocation_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_invocation_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_query_spec_id)
    REFERENCES gate_a3_connector_query_specs(tenant_id,id)
);
CREATE TRIGGER gate_a3_connector_source_snapshots_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_connector_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE TABLE gate_a3_connector_evidence (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  connector_source_snapshot_id text NOT NULL,
  connector_invocation_id text NOT NULL,
  effect_id text NOT NULL,
  connector_query_spec_hash text NOT NULL CHECK (connector_query_spec_hash ~ '^[a-f0-9]{64}$'),
  canonical_payload_hash text NOT NULL CHECK (canonical_payload_hash ~ '^[a-f0-9]{64}$'),
  work_order_ref_hash text NOT NULL CHECK (work_order_ref_hash ~ '^[a-f0-9]{64}$'),
  field_mask_version text NOT NULL,
  source_revision text NOT NULL,
  source_as_of timestamptz NOT NULL,
  locator_kind text NOT NULL CHECK (locator_kind IN ('connector_snapshot_field','connector_snapshot_whole')),
  field_name text,
  canonical_field jsonb,
  canonical_field_hash text CHECK (canonical_field_hash IS NULL OR canonical_field_hash ~ '^[a-f0-9]{64}$'),
  resource_scope text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('C0','C1')),
  audience text NOT NULL,
  accessible boolean NOT NULL CHECK (accessible),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE NULLS NOT DISTINCT (tenant_id,connector_source_snapshot_id,locator_kind,field_name),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_source_snapshot_id)
    REFERENCES gate_a3_connector_source_snapshots(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_invocation_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id),
  CHECK ((locator_kind='connector_snapshot_whole' AND field_name IS NULL
      AND canonical_field IS NULL AND canonical_field_hash IS NULL)
    OR (locator_kind='connector_snapshot_field'
      AND field_name IN ('workOrderRef','status','planQty','completedQty','unit',
        'plannedStart','plannedEnd','updatedAt','sourceRevision')
      AND canonical_field IS NOT NULL AND canonical_field_hash IS NOT NULL))
);
CREATE TRIGGER gate_a3_connector_evidence_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_connector_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE TABLE gate_a3_model_invocations (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  connector_source_snapshot_id text NOT NULL,
  workflow_version_id text NOT NULL,
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^[a-f0-9]{64}$'),
  step_id text NOT NULL CHECK (step_id='explain_status'),
  execution_attempt_id text NOT NULL,
  step_attempt_id text NOT NULL,
  effect_id text NOT NULL,
  task_fence bigint NOT NULL CHECK (task_fence>0),
  step_fence bigint NOT NULL CHECK (step_fence>0),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  policy_version text NOT NULL,
  jti_digest text NOT NULL CHECK (jti_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  status text NOT NULL CHECK (status IN ('authorized','running','completed','failed','canceled')),
  receipt jsonb,
  receipt_digest text CHECK (receipt_digest IS NULL OR receipt_digest ~ '^[a-f0-9]{64}$'),
  error_class text,
  started_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id,step_attempt_id),
  UNIQUE (tenant_id,business_task_id,effect_id,step_attempt_id),
  UNIQUE (tenant_id,jti_digest),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_source_snapshot_id)
    REFERENCES gate_a3_connector_source_snapshots(tenant_id,id),
  CHECK (expires_at>created_at),
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
  CHECK ((status IN ('authorized','running') AND terminal_at IS NULL)
    OR (status IN ('completed','failed','canceled') AND terminal_at IS NOT NULL)),
  CHECK ((status='completed' AND receipt IS NOT NULL AND receipt_digest IS NOT NULL AND error_class IS NULL)
    OR status<>'completed')
);

CREATE TABLE gate_a3_work_order_explanations (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  model_invocation_id text NOT NULL,
  connector_source_snapshot_id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version='work-order.explanation/1'),
  explanation jsonb NOT NULL CHECK (jsonb_typeof(explanation)='object'),
  explanation_hash text NOT NULL CHECK (explanation_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id),
  UNIQUE (tenant_id,model_invocation_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES gate_a3_model_invocations(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_source_snapshot_id)
    REFERENCES gate_a3_connector_source_snapshots(tenant_id,id),
  CHECK (explanation->>'schemaVersion'=schema_version)
);
CREATE TRIGGER gate_a3_work_order_explanations_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_work_order_explanations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE TABLE gate_a3_work_order_results (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  connector_source_snapshot_id text NOT NULL,
  connector_invocation_id text NOT NULL,
  explanation_id text NOT NULL,
  effect_id text NOT NULL,
  record_variant text NOT NULL CHECK (record_variant='business-task-result.work-order.live/1'),
  card_schema_version text NOT NULL CHECK (card_schema_version='WorkOrderStatusCard/1'),
  card jsonb NOT NULL CHECK (jsonb_typeof(card)='object'),
  card_hash text NOT NULL CHECK (card_hash ~ '^[a-f0-9]{64}$'),
  public_result jsonb NOT NULL CHECK (jsonb_typeof(public_result)='object'),
  public_result_hash text NOT NULL CHECK (public_result_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id),
  UNIQUE (tenant_id,business_task_id,effect_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_source_snapshot_id)
    REFERENCES gate_a3_connector_source_snapshots(tenant_id,id),
  FOREIGN KEY (tenant_id,connector_invocation_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id),
  FOREIGN KEY (tenant_id,explanation_id)
    REFERENCES gate_a3_work_order_explanations(tenant_id,id),
  CHECK (card->>'schemaVersion'=card_schema_version),
  CHECK (public_result->>'kind'='work_order_status')
);
CREATE TRIGGER gate_a3_work_order_results_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_work_order_results
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE OR REPLACE FUNCTION guard_live_business_task_active_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_capability_id text;
  active_capability_version_id text;
  active_state text;
BEGIN
  IF NEW.record_variant IS DISTINCT FROM 'business-task.live/1'
    AND NEW.record_variant IS DISTINCT FROM 'business-task.work-order.live/1' THEN
    RETURN NEW;
  END IF;
  SELECT capability.capability_id INTO task_capability_id
    FROM capability_versions capability
    WHERE capability.tenant_id=NEW.tenant_id AND capability.id=NEW.capability_version_id;
  SELECT release.capability_version_id,release.state
    INTO active_capability_version_id,active_state
    FROM capability_active_releases active
    JOIN capability_release_records release
      ON release.tenant_id=active.tenant_id AND release.id=active.release_id
    WHERE active.tenant_id=NEW.tenant_id AND active.capability_id=task_capability_id
    FOR SHARE OF active;
  IF active_state IS DISTINCT FROM 'internal'
    OR active_capability_version_id IS DISTINCT FROM NEW.capability_version_id THEN
    RAISE EXCEPTION 'live business task capability version is not the locked active internal release';
  END IF;
  RETURN NEW;
END $$;

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
  IF NEW.record_variant='business-task.work-order.live/1' AND NEW.status='completed' AND (
    NOT EXISTS (SELECT 1 FROM gate_a3_work_order_results result
      WHERE result.tenant_id=NEW.tenant_id AND result.business_task_id=NEW.id)
    OR NOT EXISTS (SELECT 1 FROM gate_a3_connector_source_snapshots snapshot
      WHERE snapshot.tenant_id=NEW.tenant_id AND snapshot.business_task_id=NEW.id)
    OR NOT EXISTS (SELECT 1 FROM gate_a3_work_order_explanations explanation
      WHERE explanation.tenant_id=NEW.tenant_id AND explanation.business_task_id=NEW.id)
    OR EXISTS (SELECT 1 FROM gate_a3_connector_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id
        AND NOT evidence.accessible)
    OR (SELECT count(*) FROM gate_a3_connector_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id) < 5
  ) THEN
    RAISE EXCEPTION 'completed Gate A Work Order task requires one atomic snapshot/evidence/explanation/result authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
