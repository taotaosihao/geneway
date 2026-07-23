-- Gate 0.2B.2: immutable BusinessException source authority and the mutable
-- aggregate that projects it.  This migration is forward-only; source rows,
-- event rows, bindings, and their hashes deliberately have no update path.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS input_digest text;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_input_digest_check
  CHECK (input_digest IS NULL OR input_digest ~ '^[a-f0-9]{64}$');

CREATE TABLE IF NOT EXISTS control_plane_database_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  is_non_production boolean NOT NULL,
  environment_name text NOT NULL CHECK (length(environment_name) BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_exceptions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  source_version_id text NOT NULL,
  source_system text NOT NULL CHECK (source_system='fixture-manufacturing'),
  exception_type text NOT NULL CHECK (exception_type IN ('capacity_progress_lag','equipment_alarm')),
  source_object_ref text NOT NULL CHECK (length(source_object_ref) BETWEEN 1 AND 300),
  detection_window text NOT NULL CHECK (length(detection_window) BETWEEN 1 AND 200),
  fixture_version text NOT NULL CHECK (fixture_version IN ('gate0.2b-capacity-lag/1','gate0.2b-equipment-alarm/1')),
  fixture_sha256 text NOT NULL CHECK (fixture_sha256 ~ '^[a-f0-9]{64}$'),
  canonicalization_version text NOT NULL CHECK (canonicalization_version='rfc8785-jcs/1'),
  resource_scope text NOT NULL CHECK (length(resource_scope) BETWEEN 1 AND 500),
  data_class text NOT NULL CHECK (data_class='C1'),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  detected_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
  owner_principal_id text,
  acknowledged_at timestamptz,
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  simulation boolean NOT NULL DEFAULT true CHECK (simulation),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,source_version_id),
  UNIQUE (tenant_id,id,source_version_id),
  UNIQUE (tenant_id,source_system,exception_type,source_object_ref,detection_window),
  FOREIGN KEY (tenant_id,owner_principal_id) REFERENCES users(tenant_id,id),
  CHECK (
    (status='open' AND owner_principal_id IS NULL AND acknowledged_at IS NULL)
    OR (status='acknowledged' AND owner_principal_id IS NOT NULL AND acknowledged_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS business_exception_source_snapshots (
  tenant_id text NOT NULL,
  source_version_id text NOT NULL,
  business_exception_id text NOT NULL,
  canonical_bytes bytea NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 1 AND 262144),
  canonical_sha256 text NOT NULL CHECK (canonical_sha256 ~ '^[a-f0-9]{64}$'),
  canonicalization_version text NOT NULL CHECK (canonicalization_version='rfc8785-jcs/1'),
  fixture_version text NOT NULL CHECK (fixture_version IN ('gate0.2b-capacity-lag/1','gate0.2b-equipment-alarm/1')),
  source_system text NOT NULL CHECK (source_system='fixture-manufacturing'),
  source_object_ref text NOT NULL CHECK (length(source_object_ref) BETWEEN 1 AND 300),
  detection_window text NOT NULL CHECK (length(detection_window) BETWEEN 1 AND 200),
  resource_scope text NOT NULL CHECK (length(resource_scope) BETWEEN 1 AND 500),
  data_class text NOT NULL CHECK (data_class='C1'),
  audience jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,source_version_id),
  UNIQUE (tenant_id,business_exception_id),
  UNIQUE (tenant_id,business_exception_id,source_version_id),
  FOREIGN KEY (tenant_id,business_exception_id,source_version_id)
    REFERENCES business_exceptions(tenant_id,id,source_version_id),
  CHECK (audience=jsonb_build_object(
    'kind','resource_exception','businessExceptionId',business_exception_id,
    'resourceScope',resource_scope,'dataClass',data_class
  )),
  CHECK (canonical_sha256=encode(digest(canonical_bytes,'sha256'),'hex'))
);

CREATE TABLE IF NOT EXISTS business_exception_events (
  cursor bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_exception_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'business_exception.detected','business_exception.acknowledged','business_exception.analysis_bound'
  )),
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 200),
  causation_id text,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,business_exception_id,sequence),
  UNIQUE (tenant_id,business_exception_id,aggregate_version),
  FOREIGN KEY (tenant_id,business_exception_id) REFERENCES business_exceptions(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS business_exception_analysis_bindings (
  tenant_id text NOT NULL,
  source_version_id text NOT NULL,
  business_exception_id text NOT NULL,
  business_task_id text NOT NULL,
  requester_principal_id text NOT NULL,
  private_conversation_id text NOT NULL,
  requested_expert_target jsonb NOT NULL,
  resolved_expert_target jsonb NOT NULL,
  expert_catalog_version text NOT NULL,
  capability_version_id text NOT NULL,
  permission_ceiling jsonb NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  source_audience jsonb NOT NULL,
  task_audience jsonb NOT NULL,
  permission_intersection_digest text NOT NULL CHECK (permission_intersection_digest ~ '^[a-f0-9]{64}$'),
  approval_subject_digest text NOT NULL CHECK (approval_subject_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,source_version_id),
  UNIQUE (tenant_id,business_exception_id),
  UNIQUE (tenant_id,business_task_id),
  FOREIGN KEY (tenant_id,source_version_id) REFERENCES business_exception_source_snapshots(tenant_id,source_version_id),
  FOREIGN KEY (tenant_id,business_exception_id,source_version_id)
    REFERENCES business_exception_source_snapshots(tenant_id,business_exception_id,source_version_id),
  FOREIGN KEY (tenant_id,business_exception_id) REFERENCES business_exceptions(tenant_id,id),
  FOREIGN KEY (tenant_id,business_task_id,private_conversation_id,requester_principal_id)
    REFERENCES business_tasks(tenant_id,id,conversation_id,requester_id),
  CHECK (task_audience=jsonb_build_object('kind','private_conversation','conversationId',private_conversation_id)),
  CHECK (source_audience->>'kind'='resource_exception'),
  CHECK (source_audience->>'businessExceptionId'=business_exception_id)
);

CREATE INDEX IF NOT EXISTS business_exceptions_list_idx
  ON business_exceptions (tenant_id,detected_at DESC,id ASC);
CREATE INDEX IF NOT EXISTS business_exceptions_severity_idx
  ON business_exceptions (tenant_id,severity,detected_at DESC,id ASC);
CREATE INDEX IF NOT EXISTS business_exceptions_scope_idx
  ON business_exceptions (tenant_id,resource_scope,status);
CREATE INDEX IF NOT EXISTS business_exception_events_aggregate_idx
  ON business_exception_events (tenant_id,business_exception_id,aggregate_version);

-- Query snapshots are a shared 0.2B authority.  Add the exception consumer;
-- no parallel cursor or browser-owned pagination store is introduced.
ALTER TABLE query_snapshots DROP CONSTRAINT IF EXISTS query_snapshots_query_kind_check;
ALTER TABLE query_snapshots ADD CONSTRAINT query_snapshots_query_kind_check
  CHECK (query_kind IN ('business_tasks','workflow_versions','business_exceptions'));

-- Exception task evidence is still task-scoped and keeps the existing
-- conversation audience encoding internally.  Only the public discriminant is
-- business_exception_snapshot.
ALTER TABLE evidence_items DROP CONSTRAINT IF EXISTS evidence_items_source_kind_check;
ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_source_kind_check
  CHECK (source_kind IN ('legacy_fixture','document_snapshot','business_exception_snapshot'));
ALTER TABLE evidence_items DROP CONSTRAINT IF EXISTS evidence_items_check;
ALTER TABLE evidence_items ADD CONSTRAINT evidence_items_check CHECK (
  (source_kind='legacy_fixture'
    AND source->>'kind'='legacy_fixture'
    AND source->>'fixtureRef'='fixture:solution-analysis:v1'
    AND source->>'fixtureVersion'='1'
    AND length(source->>'sourceId') > 0
    AND source->>'excerptSha256'=excerpt_sha256)
  OR
  (source_kind='document_snapshot'
    AND source->>'kind'='document_snapshot'
    AND length(source->>'documentSnapshotId') > 0
    AND length(source->>'artifactId') > 0
    AND (source->>'startByte') ~ '^[0-9]+$'
    AND (source->>'endByteExclusive') ~ '^[1-9][0-9]*$'
    AND (source->>'startByte')::numeric < (source->>'endByteExclusive')::numeric
    AND (source->>'snapshotSha256') ~ '^[a-f0-9]{64}$'
    AND source->>'excerptSha256'=excerpt_sha256
    AND source->>'extractionVersion'='raw-utf8-byte-range/1'
    AND resource_scope='artifact:' || (source->>'artifactId')
    AND data_class='C1'
    AND accessible)
  OR
  (source_kind='business_exception_snapshot'
    AND source->>'kind'='business_exception_snapshot'
    AND length(source->>'businessExceptionId') > 0
    AND length(source->>'sourceVersionId') > 0
    AND (source->>'sourceSha256') ~ '^[a-f0-9]{64}$'
    AND source->>'canonicalizationVersion'='rfc8785-jcs/1'
    AND (source->>'jsonPointer') ~ '^/'
    AND (source->>'valueSha256') ~ '^[a-f0-9]{64}$'
    AND data_class='C1'
    AND accessible)
);

CREATE OR REPLACE FUNCTION ensure_business_exception_evidence_source_is_current() RETURNS trigger AS $$
BEGIN
  IF NEW.source_kind='business_exception_snapshot' AND NOT EXISTS (
    SELECT 1
    FROM business_exception_source_snapshots snapshot
    JOIN business_exception_analysis_bindings binding
      ON binding.tenant_id=snapshot.tenant_id AND binding.source_version_id=snapshot.source_version_id
    JOIN business_tasks task
      ON task.tenant_id=binding.tenant_id AND task.id=binding.business_task_id
    WHERE snapshot.tenant_id=NEW.tenant_id
      AND snapshot.business_exception_id=NEW.source->>'businessExceptionId'
      AND snapshot.source_version_id=NEW.source->>'sourceVersionId'
      AND snapshot.canonical_sha256=NEW.source->>'sourceSha256'
      AND snapshot.canonicalization_version=NEW.source->>'canonicalizationVersion'
      AND snapshot.resource_scope=NEW.resource_scope
      AND snapshot.data_class=NEW.data_class
      AND binding.business_task_id=NEW.business_task_id
      AND NEW.audience='conversation:' || binding.private_conversation_id
      AND task.requester_id=binding.requester_principal_id
  ) THEN
    RAISE EXCEPTION 'business exception evidence must reference the bound current source in the private task audience';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_items_exception_source_guard ON evidence_items;
CREATE CONSTRAINT TRIGGER evidence_items_exception_source_guard
  AFTER INSERT OR UPDATE ON evidence_items DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_business_exception_evidence_source_is_current();

-- Existing outbox rows remain task events.  Exception lifecycle events reuse
-- the same authority with exactly one aggregate owner.
ALTER TABLE outbox_events ALTER COLUMN business_task_id DROP NOT NULL;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS business_exception_id text;
ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_business_task_id_fkey;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_business_task_fk
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_business_exception_fk
  FOREIGN KEY (tenant_id,business_exception_id) REFERENCES business_exceptions(tenant_id,id);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_single_aggregate_check CHECK (
  (business_task_id IS NOT NULL AND business_exception_id IS NULL)
  OR (business_task_id IS NULL AND business_exception_id IS NOT NULL)
);

-- A report publish intent binds to exactly one immutable source authority.
-- Document reports retain their source/root Artifact pair; exception reports
-- bind directly to the source version and never invent a root Artifact.
ALTER TABLE report_publish_intents ADD COLUMN IF NOT EXISTS business_exception_source_version_id text;
ALTER TABLE report_publish_intents ALTER COLUMN source_document_snapshot_id DROP NOT NULL;
ALTER TABLE report_publish_intents ALTER COLUMN root_artifact_id DROP NOT NULL;
ALTER TABLE report_publish_intents DROP CONSTRAINT IF EXISTS report_publish_intents_template_id_check;
ALTER TABLE report_publish_intents ADD CONSTRAINT report_publish_intents_template_id_check
  CHECK (template_id IN ('gate0.2a-report/v1','gate0.2b-exception-report/v1'));
ALTER TABLE report_publish_intents DROP CONSTRAINT IF EXISTS report_publish_intents_resource_scope_check;
ALTER TABLE report_publish_intents ADD CONSTRAINT report_publish_intents_source_xor_check CHECK (
  (source_document_snapshot_id IS NOT NULL AND root_artifact_id IS NOT NULL
    AND business_exception_source_version_id IS NULL AND resource_scope='artifact:' || root_artifact_id)
  OR
  (source_document_snapshot_id IS NULL AND root_artifact_id IS NULL
    AND business_exception_source_version_id IS NOT NULL)
);
ALTER TABLE report_publish_intents ADD CONSTRAINT report_publish_intents_exception_source_fk
  FOREIGN KEY (tenant_id,business_exception_source_version_id)
  REFERENCES business_exception_source_snapshots(tenant_id,source_version_id);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS business_exception_source_version_id text;
ALTER TABLE artifacts ALTER COLUMN root_artifact_id DROP NOT NULL;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_resource_scope_check;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_binding_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_source_xor_check CHECK (
  (kind='source_document' AND business_task_id IS NULL AND root_artifact_id=id
    AND business_exception_source_version_id IS NULL AND resource_scope='artifact:' || id)
  OR
  (kind='simulation_report' AND business_task_id IS NOT NULL AND (
    (root_artifact_id IS NOT NULL AND root_artifact_id<>id
      AND business_exception_source_version_id IS NULL AND resource_scope='artifact:' || root_artifact_id)
    OR
    (root_artifact_id IS NULL AND business_exception_source_version_id IS NOT NULL)
  ))
);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_exception_source_fk
  FOREIGN KEY (tenant_id,business_exception_source_version_id)
  REFERENCES business_exception_source_snapshots(tenant_id,source_version_id);

CREATE OR REPLACE FUNCTION ensure_artifact_root_is_source() RETURNS trigger AS $$
BEGIN
  IF NEW.kind='simulation_report' AND NEW.root_artifact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifacts root
    WHERE root.tenant_id=NEW.tenant_id AND root.id=NEW.root_artifact_id
      AND root.kind='source_document' AND root.conversation_id=NEW.conversation_id
      AND root.owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'simulation report root must be a source document in the same private conversation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_exception_report_source_is_current() RETURNS trigger AS $$
DECLARE source_version text;
BEGIN
  IF TG_TABLE_NAME='report_publish_intents' THEN
    source_version := NEW.business_exception_source_version_id;
  ELSE
    source_version := NEW.business_exception_source_version_id;
  END IF;
  IF source_version IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM business_exception_source_snapshots snapshot
    JOIN business_exception_analysis_bindings binding
      ON binding.tenant_id=snapshot.tenant_id AND binding.source_version_id=snapshot.source_version_id
    JOIN business_tasks task
      ON task.tenant_id=binding.tenant_id AND task.id=binding.business_task_id
    WHERE snapshot.tenant_id=NEW.tenant_id AND snapshot.source_version_id=source_version
      AND binding.business_task_id=NEW.business_task_id
      AND binding.private_conversation_id=NEW.conversation_id
      AND binding.requester_principal_id=NEW.owner_user_id
      AND task.input_snapshot->>'sourceSha256'=snapshot.canonical_sha256
      AND task.input_snapshot->>'resourceScope'=snapshot.resource_scope
      AND task.input_snapshot->>'dataClass'=snapshot.data_class
      AND task.input_snapshot->'sourceAudience'=snapshot.audience
      AND task.input_snapshot->'taskAudience'=binding.task_audience
      AND NEW.resource_scope=snapshot.resource_scope AND NEW.data_class=snapshot.data_class
      AND NEW.audience::text=CASE
        WHEN TG_TABLE_NAME='artifacts'
          THEN jsonb_build_object('kind','private-conversation','conversationId',binding.private_conversation_id)::text
        ELSE 'conversation:' || binding.private_conversation_id
      END
  ) THEN
    RAISE EXCEPTION 'exception report must retain its immutable source and private task audience';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_publish_intents_exception_source_guard ON report_publish_intents;
CREATE CONSTRAINT TRIGGER report_publish_intents_exception_source_guard
  AFTER INSERT OR UPDATE ON report_publish_intents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_exception_report_source_is_current();

DROP TRIGGER IF EXISTS artifacts_exception_source_guard ON artifacts;
CREATE CONSTRAINT TRIGGER artifacts_exception_source_guard
  AFTER INSERT OR UPDATE ON artifacts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_exception_report_source_is_current();

CREATE OR REPLACE FUNCTION reject_exception_report_source_rewrite() RETURNS trigger AS $$
BEGIN
  IF NEW.business_exception_source_version_id IS DISTINCT FROM OLD.business_exception_source_version_id THEN
    RAISE EXCEPTION 'report source version is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_publish_intents_exception_source_immutable ON report_publish_intents;
CREATE TRIGGER report_publish_intents_exception_source_immutable
  BEFORE UPDATE ON report_publish_intents FOR EACH ROW EXECUTE FUNCTION reject_exception_report_source_rewrite();

CREATE OR REPLACE FUNCTION ensure_published_report_is_verified() RETURNS trigger AS $$
BEGIN
  IF NEW.status='published' AND NOT EXISTS (
    SELECT 1
    FROM artifacts artifact
    JOIN artifact_manifests manifest
      ON manifest.tenant_id=artifact.tenant_id AND manifest.artifact_id=artifact.id
    JOIN artifact_states state
      ON state.tenant_id=artifact.tenant_id AND state.artifact_id=artifact.id
    JOIN execution_attempts attempt
      ON attempt.tenant_id=NEW.tenant_id AND attempt.id=NEW.execution_attempt_id
    JOIN attempt_output_candidates candidate
      ON candidate.tenant_id=NEW.tenant_id AND candidate.id=NEW.candidate_id
    JOIN business_tasks task
      ON task.tenant_id=NEW.tenant_id AND task.id=NEW.business_task_id
    WHERE artifact.tenant_id=NEW.tenant_id AND artifact.id=NEW.artifact_id
      AND artifact.kind='simulation_report' AND artifact.business_task_id=NEW.business_task_id
      AND artifact.root_artifact_id IS NOT DISTINCT FROM NEW.root_artifact_id
      AND artifact.business_exception_source_version_id IS NOT DISTINCT FROM NEW.business_exception_source_version_id
      AND artifact.conversation_id=NEW.conversation_id AND artifact.owner_user_id=NEW.owner_user_id
      AND artifact.resource_scope=NEW.resource_scope AND artifact.data_class=NEW.data_class
      AND artifact.audience=jsonb_build_object('kind','private-conversation','conversationId',NEW.conversation_id)
      AND artifact.size_bytes=NEW.size_bytes AND artifact.content_sha256=NEW.content_sha256
      AND manifest.id=NEW.manifest_id AND manifest.storage_bucket=NEW.storage_bucket
      AND manifest.storage_key=NEW.storage_key AND manifest.size_bytes=NEW.size_bytes
      AND manifest.content_sha256=NEW.content_sha256
      AND attempt.business_task_id=NEW.business_task_id AND attempt.status='completed'
      AND candidate.business_task_id=NEW.business_task_id
      AND candidate.execution_attempt_id=NEW.execution_attempt_id
      AND candidate.execution_version=attempt.execution_version AND candidate.fencing_token=attempt.fencing_token
      AND task.current_execution_attempt_id=attempt.id AND task.execution_version=attempt.execution_version
      AND task.execution_fencing_token=attempt.fencing_token AND task.status='completed'
      AND state.availability='active' AND state.integrity='verified'
      AND state.retention_status='active' AND state.retention_expires_at>now()
      AND state.reconcile_status='in_sync'
      AND (
        (NEW.source_document_snapshot_id IS NOT NULL AND NEW.business_exception_source_version_id IS NULL
          AND EXISTS (
            SELECT 1 FROM document_snapshots source_snapshot
            JOIN artifact_states source_state
              ON source_state.tenant_id=source_snapshot.tenant_id AND source_state.artifact_id=source_snapshot.artifact_id
            WHERE source_snapshot.tenant_id=NEW.tenant_id AND source_snapshot.id=NEW.source_document_snapshot_id
              AND source_snapshot.artifact_id=NEW.root_artifact_id
              AND source_snapshot.conversation_id=NEW.conversation_id
              AND source_state.availability='active' AND source_state.integrity='verified'
              AND source_state.retention_status='active' AND source_state.retention_expires_at>now()
              AND source_state.reconcile_status='in_sync'
          ))
        OR
        (NEW.source_document_snapshot_id IS NULL AND NEW.business_exception_source_version_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM business_exception_source_snapshots source_snapshot
            JOIN business_exception_analysis_bindings source_binding
              ON source_binding.tenant_id=source_snapshot.tenant_id
              AND source_binding.source_version_id=source_snapshot.source_version_id
            JOIN resource_scopes readable_scope ON readable_scope.tenant_id=source_snapshot.tenant_id
              AND readable_scope.user_id=NEW.owner_user_id
            JOIN roles readable_role ON readable_role.tenant_id=source_snapshot.tenant_id
              AND readable_role.user_id=NEW.owner_user_id AND readable_role.role='solution_reviewer'
            WHERE source_snapshot.tenant_id=NEW.tenant_id
              AND source_snapshot.source_version_id=NEW.business_exception_source_version_id
              AND source_binding.business_task_id=NEW.business_task_id
              AND source_binding.private_conversation_id=NEW.conversation_id
              AND source_binding.requester_principal_id=NEW.owner_user_id
              AND source_snapshot.canonical_sha256=task.input_snapshot->>'sourceSha256'
              AND source_snapshot.resource_scope=NEW.resource_scope
              AND source_snapshot.data_class=NEW.data_class
              AND source_snapshot.audience=task.input_snapshot->'sourceAudience'
              AND source_binding.task_audience=task.input_snapshot->'taskAudience'
              AND (source_snapshot.resource_scope=readable_scope.resource_scope
                OR source_snapshot.resource_scope LIKE readable_scope.resource_scope || '/%')
          ))
      )
  ) THEN
    RAISE EXCEPTION 'published report intent requires a current authorized source and matching verified report artifact';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION geneway_reject_business_exception_source_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'business exception source authority cannot be deleted'; END IF;
  IF ROW(NEW.tenant_id,NEW.id,NEW.source_version_id,NEW.source_system,NEW.exception_type,
         NEW.source_object_ref,NEW.detection_window,NEW.fixture_version,NEW.fixture_sha256,
         NEW.canonicalization_version,NEW.resource_scope,NEW.data_class,NEW.summary,
         NEW.severity,NEW.detected_at,NEW.simulation,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id,OLD.id,OLD.source_version_id,OLD.source_system,OLD.exception_type,
         OLD.source_object_ref,OLD.detection_window,OLD.fixture_version,OLD.fixture_sha256,
         OLD.canonicalization_version,OLD.resource_scope,OLD.data_class,OLD.summary,
         OLD.severity,OLD.detected_at,OLD.simulation,OLD.created_at) THEN
    RAISE EXCEPTION 'business exception source fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_exceptions_source_immutable ON business_exceptions;
CREATE TRIGGER business_exceptions_source_immutable
  BEFORE UPDATE OR DELETE ON business_exceptions
  FOR EACH ROW EXECUTE FUNCTION geneway_reject_business_exception_source_mutation();

DROP TRIGGER IF EXISTS business_exception_source_snapshots_immutable ON business_exception_source_snapshots;
CREATE TRIGGER business_exception_source_snapshots_immutable
  BEFORE UPDATE OR DELETE ON business_exception_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

DROP TRIGGER IF EXISTS business_exception_events_append_only ON business_exception_events;
CREATE TRIGGER business_exception_events_append_only
  BEFORE UPDATE OR DELETE ON business_exception_events
  FOR EACH ROW EXECUTE FUNCTION reject_task_event_update();

DROP TRIGGER IF EXISTS business_exception_analysis_bindings_immutable ON business_exception_analysis_bindings;
CREATE TRIGGER business_exception_analysis_bindings_immutable
  BEFORE UPDATE OR DELETE ON business_exception_analysis_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE OR REPLACE FUNCTION ensure_business_exception_binding_matches_task() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_tasks task
    JOIN approval_versions approval
      ON approval.tenant_id=task.tenant_id AND approval.business_task_id=task.id
      AND approval.version=(SELECT max(latest.version) FROM approval_versions latest
        WHERE latest.tenant_id=task.tenant_id AND latest.business_task_id=task.id)
    WHERE task.tenant_id=NEW.tenant_id
      AND task.id=NEW.business_task_id
      AND task.conversation_id=NEW.private_conversation_id
      AND task.requester_id=NEW.requester_principal_id
      AND task.expert_catalog_version_id=NEW.expert_catalog_version
      AND task.capability_version_id=NEW.capability_version_id
      AND task.expert_target->'requested'=NEW.requested_expert_target
      AND task.expert_target->'resolved'=NEW.resolved_expert_target
      AND task.input_digest=NEW.input_digest
      AND approval.subject_digest=NEW.approval_subject_digest
      AND approval.subject->>'inputDigest'=NEW.input_digest
      AND approval.subject->'requestedExpertTarget'=NEW.requested_expert_target
      AND approval.subject->'resolvedExpertTarget'=NEW.resolved_expert_target
      AND approval.subject->>'expertCatalogVersionId'=NEW.expert_catalog_version
  ) THEN
    RAISE EXCEPTION 'business exception analysis binding must match task and approval authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS business_exception_analysis_bindings_task_guard
  ON business_exception_analysis_bindings;
CREATE CONSTRAINT TRIGGER business_exception_analysis_bindings_task_guard
  AFTER INSERT OR UPDATE ON business_exception_analysis_bindings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION ensure_business_exception_binding_matches_task();

CREATE OR REPLACE FUNCTION ensure_business_exception_task_authority_stays_aligned() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM business_exception_analysis_bindings binding
    WHERE binding.tenant_id=NEW.tenant_id AND binding.business_task_id=NEW.id
  ) AND NOT EXISTS (
    SELECT 1 FROM business_exception_analysis_bindings binding
    JOIN approval_versions approval
      ON approval.tenant_id=binding.tenant_id AND approval.business_task_id=binding.business_task_id
      AND approval.version=(SELECT max(latest.version) FROM approval_versions latest
        WHERE latest.tenant_id=binding.tenant_id AND latest.business_task_id=binding.business_task_id)
    WHERE binding.tenant_id=NEW.tenant_id AND binding.business_task_id=NEW.id
      AND NEW.conversation_id=binding.private_conversation_id
      AND NEW.requester_id=binding.requester_principal_id
      AND NEW.expert_catalog_version_id=binding.expert_catalog_version
      AND NEW.capability_version_id=binding.capability_version_id
      AND NEW.expert_target->'requested'=binding.requested_expert_target
      AND NEW.expert_target->'resolved'=binding.resolved_expert_target
      AND NEW.input_digest=binding.input_digest
      AND approval.subject_digest=binding.approval_subject_digest
      AND approval.subject->>'inputDigest'=binding.input_digest
      AND approval.subject->'requestedExpertTarget'=binding.requested_expert_target
      AND approval.subject->'resolvedExpertTarget'=binding.resolved_expert_target
      AND approval.subject->>'expertCatalogVersionId'=binding.expert_catalog_version
  ) THEN
    RAISE EXCEPTION 'business exception task authority no longer matches its approved singleton binding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS business_tasks_exception_authority_guard ON business_tasks;
CREATE CONSTRAINT TRIGGER business_tasks_exception_authority_guard
  AFTER UPDATE ON business_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION ensure_business_exception_task_authority_stays_aligned();

CREATE OR REPLACE FUNCTION ensure_business_exception_approval_authority_stays_aligned() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM business_exception_analysis_bindings binding
    WHERE binding.tenant_id=NEW.tenant_id AND binding.business_task_id=NEW.business_task_id
  ) AND NOT EXISTS (
    SELECT 1 FROM business_exception_analysis_bindings binding
    JOIN business_tasks task
      ON task.tenant_id=binding.tenant_id AND task.id=binding.business_task_id
    WHERE binding.tenant_id=NEW.tenant_id AND binding.business_task_id=NEW.business_task_id
      AND NEW.subject_digest=binding.approval_subject_digest
      AND NEW.subject->>'inputDigest'=binding.input_digest
      AND NEW.subject->'requestedExpertTarget'=binding.requested_expert_target
      AND NEW.subject->'resolvedExpertTarget'=binding.resolved_expert_target
      AND NEW.subject->>'expertCatalogVersionId'=binding.expert_catalog_version
      AND task.input_digest=binding.input_digest
  ) THEN
    RAISE EXCEPTION 'business exception approval no longer matches its immutable task input digest';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approval_versions_exception_authority_guard ON approval_versions;
CREATE CONSTRAINT TRIGGER approval_versions_exception_authority_guard
  AFTER INSERT OR UPDATE ON approval_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION ensure_business_exception_approval_authority_stays_aligned();
