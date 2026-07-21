ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS principal_id text;

UPDATE idempotency_records i
SET principal_id = CASE
  WHEN i.operation = 'conversation.create' THEN (
    SELECT c.user_id
    FROM conversations c
    WHERE c.tenant_id = i.tenant_id AND c.id = i.response->>'id'
  )
  WHEN i.operation = 'conversation.message.create' THEN (
    SELECT c.user_id
    FROM messages m
    JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
    WHERE m.tenant_id = i.tenant_id AND m.id = i.response->>'id'
  )
  WHEN i.operation IN ('business-task.create','business-task.execute') THEN (
    SELECT t.requester_id
    FROM business_tasks t
    WHERE t.tenant_id = i.tenant_id AND t.id = i.response->>'taskId'
  )
  WHEN i.operation = 'approval.decide' THEN (
    SELECT t.requester_id
    FROM approval_versions a
    JOIN business_tasks t ON t.tenant_id = a.tenant_id AND t.id = a.business_task_id
    WHERE a.tenant_id = i.tenant_id AND a.id = i.response->>'approvalId'
  )
END
WHERE principal_id IS NULL;

DO $$
DECLARE unresolved_count bigint;
BEGIN
  SELECT count(*) INTO unresolved_count FROM idempotency_records WHERE principal_id IS NULL;
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'cannot safely backfill principal_id for % idempotency record(s)', unresolved_count;
  END IF;
END;
$$;

ALTER TABLE idempotency_records ALTER COLUMN principal_id SET NOT NULL;
ALTER TABLE idempotency_records DROP CONSTRAINT IF EXISTS idempotency_records_pkey;
ALTER TABLE idempotency_records ADD PRIMARY KEY (tenant_id,principal_id,operation,idempotency_key);
ALTER TABLE idempotency_records DROP CONSTRAINT IF EXISTS idempotency_records_principal_fk;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_principal_fk
  FOREIGN KEY (tenant_id,principal_id) REFERENCES users(tenant_id,id);

ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS execution_version bigint NOT NULL DEFAULT 0;
ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS current_execution_attempt_id text;
ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS execution_fencing_token bigint NOT NULL DEFAULT 0;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_execution_version_check
  CHECK (execution_version >= 0 AND execution_fencing_token >= 0);
ALTER TABLE conversations ADD CONSTRAINT conversations_owner_uq UNIQUE (tenant_id,id,user_id);
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_requester_fk
  FOREIGN KEY (tenant_id,requester_id) REFERENCES users(tenant_id,id);
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_conversation_requester_fk
  FOREIGN KEY (tenant_id,conversation_id,requester_id) REFERENCES conversations(tenant_id,id,user_id);
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_context_uq
  UNIQUE (tenant_id,id,conversation_id,requester_id);

DROP TRIGGER IF EXISTS artifacts_immutable ON artifacts;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS business_task_id text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS root_artifact_id text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS data_class text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS audience jsonb;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS resource_scope text;
UPDATE artifacts a SET
  root_artifact_id=a.id,
  data_class='C1',
  audience=jsonb_build_object('kind','private-conversation','conversationId',a.conversation_id),
  resource_scope='artifact:' || a.id
WHERE a.root_artifact_id IS NULL;
ALTER TABLE artifacts ALTER COLUMN root_artifact_id SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN data_class SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN audience SET NOT NULL;
ALTER TABLE artifacts ALTER COLUMN resource_scope SET NOT NULL;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN ('source_document','simulation_report'));
ALTER TABLE artifacts ADD CONSTRAINT artifacts_data_class_check CHECK (data_class = 'C1');
ALTER TABLE artifacts ADD CONSTRAINT artifacts_resource_scope_check CHECK (resource_scope = 'artifact:' || root_artifact_id);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_private_audience_check CHECK (
  audience = jsonb_build_object('kind','private-conversation','conversationId',conversation_id)
);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_binding_check CHECK (
  (kind='source_document' AND business_task_id IS NULL AND root_artifact_id=id)
  OR
  (kind='simulation_report' AND business_task_id IS NOT NULL AND root_artifact_id<>id)
);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_root_fk
  FOREIGN KEY (tenant_id,root_artifact_id) REFERENCES artifacts(tenant_id,id);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_conversation_owner_fk
  FOREIGN KEY (tenant_id,conversation_id,owner_user_id) REFERENCES conversations(tenant_id,id,user_id);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_business_task_fk
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_report_task_context_fk
  FOREIGN KEY (tenant_id,business_task_id,conversation_id,owner_user_id)
  REFERENCES business_tasks(tenant_id,id,conversation_id,requester_id);

CREATE OR REPLACE FUNCTION ensure_artifact_root_is_source() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'simulation_report' AND NOT EXISTS (
    SELECT 1 FROM artifacts root
    WHERE root.tenant_id=NEW.tenant_id
      AND root.id=NEW.root_artifact_id
      AND root.kind='source_document'
      AND root.conversation_id=NEW.conversation_id
      AND root.owner_user_id=NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'simulation report root must be a source document in the same private conversation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifacts_source_root_guard ON artifacts;
CREATE CONSTRAINT TRIGGER artifacts_source_root_guard AFTER INSERT OR UPDATE ON artifacts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_artifact_root_is_source();

CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_task_uq
  UNIQUE (tenant_id,event_id,business_task_id);

CREATE TABLE IF NOT EXISTS execution_attempts (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  execution_version bigint NOT NULL CHECK (execution_version > 0),
  source_event_id text NOT NULL,
  consumer text NOT NULL CHECK (consumer = 'gate0.2a-worker'),
  deployment_id text NOT NULL CHECK (deployment_id = 'gate0.2a-local'),
  worker_instance_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed','canceled')),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  lease_until timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id,execution_version),
  UNIQUE (tenant_id,consumer,source_event_id),
  UNIQUE (tenant_id,id,business_task_id),
  UNIQUE (tenant_id,id,business_task_id,execution_version,fencing_token,worker_instance_id),
  UNIQUE (tenant_id,id,business_task_id,consumer,deployment_id,worker_instance_id,fencing_token,source_event_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,source_event_id,business_task_id)
    REFERENCES outbox_events(tenant_id,event_id,business_task_id),
  CHECK (length(worker_instance_id) BETWEEN 1 AND 200),
  CHECK (
    (status='running' AND completed_at IS NULL)
    OR (status IN ('completed','failed','canceled') AND completed_at IS NOT NULL)
  )
);

ALTER TABLE business_tasks DROP CONSTRAINT IF EXISTS business_tasks_current_execution_attempt_fk;
ALTER TABLE business_tasks ADD CONSTRAINT business_tasks_current_execution_attempt_fk
  FOREIGN KEY (tenant_id,current_execution_attempt_id,id)
  REFERENCES execution_attempts(tenant_id,id,business_task_id);

CREATE TABLE IF NOT EXISTS outbox_deliveries (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  consumer text NOT NULL CHECK (consumer = 'gate0.2a-worker'),
  deployment_id text NOT NULL CHECK (deployment_id = 'gate0.2a-local'),
  event_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('leased','completed','failed','canceled')),
  execution_attempt_id text NOT NULL,
  worker_instance_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  delivery_count integer NOT NULL DEFAULT 1 CHECK (delivery_count > 0),
  lease_until timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,consumer,event_id),
  UNIQUE (tenant_id,id,event_id,business_task_id,execution_attempt_id,consumer,deployment_id,worker_instance_id,fencing_token),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,event_id,business_task_id)
    REFERENCES outbox_events(tenant_id,event_id,business_task_id),
  FOREIGN KEY (tenant_id,execution_attempt_id,business_task_id,consumer,deployment_id,worker_instance_id,fencing_token,event_id)
    REFERENCES execution_attempts(tenant_id,id,business_task_id,consumer,deployment_id,worker_instance_id,fencing_token,source_event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(worker_instance_id) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS inbox_events (
  tenant_id text NOT NULL,
  consumer text NOT NULL CHECK (consumer = 'gate0.2a-worker'),
  deployment_id text NOT NULL CHECK (deployment_id = 'gate0.2a-local'),
  event_id text NOT NULL,
  delivery_id text NOT NULL,
  business_task_id text NOT NULL,
  execution_attempt_id text NOT NULL,
  worker_instance_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  status text NOT NULL CHECK (status IN ('received','processing','completed','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_at timestamptz,
  completed_at timestamptz,
  last_error text,
  PRIMARY KEY (tenant_id,consumer,event_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,delivery_id,event_id,business_task_id,execution_attempt_id,consumer,deployment_id,worker_instance_id,fencing_token)
    REFERENCES outbox_deliveries(tenant_id,id,event_id,business_task_id,execution_attempt_id,consumer,deployment_id,worker_instance_id,fencing_token)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,event_id,business_task_id)
    REFERENCES outbox_events(tenant_id,event_id,business_task_id),
  FOREIGN KEY (tenant_id,execution_attempt_id,business_task_id,consumer,deployment_id,worker_instance_id,fencing_token,event_id)
    REFERENCES execution_attempts(tenant_id,id,business_task_id,consumer,deployment_id,worker_instance_id,fencing_token,source_event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(worker_instance_id) BETWEEN 1 AND 200),
  CHECK (
    (status='received' AND processing_at IS NULL AND completed_at IS NULL)
    OR (status='processing' AND processing_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('completed','failed') AND processing_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS attempt_output_candidates (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  execution_attempt_id text NOT NULL,
  execution_version bigint NOT NULL CHECK (execution_version > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  worker_instance_id text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,execution_attempt_id),
  UNIQUE (tenant_id,worker_instance_id,idempotency_key),
  UNIQUE (tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,execution_attempt_id,business_task_id,execution_version,fencing_token,worker_instance_id)
    REFERENCES execution_attempts(tenant_id,id,business_task_id,execution_version,fencing_token,worker_instance_id),
  CHECK (length(worker_instance_id) BETWEEN 1 AND 200),
  CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CHECK (octet_length(payload::text) <= 262144)
);

CREATE TABLE IF NOT EXISTS worker_command_receipts (
  tenant_id text NOT NULL,
  execution_attempt_id text NOT NULL,
  business_task_id text NOT NULL,
  execution_version bigint NOT NULL CHECK (execution_version > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  worker_instance_id text NOT NULL,
  command_type text NOT NULL CHECK (command_type IN ('claim_step','complete_step','fail_delivery')),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,execution_attempt_id,command_type,idempotency_key),
  UNIQUE (tenant_id,worker_instance_id,idempotency_key),
  FOREIGN KEY (tenant_id,execution_attempt_id,business_task_id,execution_version,fencing_token,worker_instance_id)
    REFERENCES execution_attempts(tenant_id,id,business_task_id,execution_version,fencing_token,worker_instance_id),
  CHECK (length(worker_instance_id) BETWEEN 1 AND 200),
  CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CHECK (octet_length(response::text) <= 65536)
);

CREATE TRIGGER worker_command_receipts_immutable BEFORE UPDATE OR DELETE ON worker_command_receipts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE TABLE IF NOT EXISTS claims (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  candidate_id text,
  text text NOT NULL,
  status text NOT NULL CHECK (status IN ('published','rejected')),
  rejection_code text,
  resource_scope text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('C0','C1','C2')),
  audience text NOT NULL,
  simulation boolean NOT NULL CHECK (simulation),
  runtime_mode text NOT NULL CHECK (runtime_mode='fake'),
  business_decision_allowed boolean NOT NULL CHECK (NOT business_decision_allowed),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,candidate_id,business_task_id)
    REFERENCES attempt_output_candidates(tenant_id,id,business_task_id),
  CHECK (length(text) BETWEEN 1 AND 2000),
  CHECK (audience ~ '^conversation:[^[:space:]]+$'),
  CHECK ((status='published' AND rejection_code IS NULL) OR (status='rejected' AND rejection_code IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS evidence_items (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  candidate_id text,
  source_kind text NOT NULL CHECK (source_kind IN ('legacy_fixture','document_snapshot')),
  source jsonb NOT NULL,
  source_excerpt text NOT NULL,
  excerpt_sha256 text NOT NULL CHECK (excerpt_sha256 ~ '^[a-f0-9]{64}$'),
  resource_scope text NOT NULL,
  data_class text NOT NULL CHECK (data_class IN ('C0','C1','C2')),
  audience text NOT NULL,
  accessible boolean NOT NULL,
  simulation boolean NOT NULL CHECK (simulation),
  runtime_mode text NOT NULL CHECK (runtime_mode='fake'),
  business_decision_allowed boolean NOT NULL CHECK (NOT business_decision_allowed),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,candidate_id,business_task_id)
    REFERENCES attempt_output_candidates(tenant_id,id,business_task_id),
  CHECK (length(source_excerpt) > 0),
  CHECK (audience ~ '^conversation:[^[:space:]]+$'),
  CHECK (
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
  )
);

CREATE OR REPLACE FUNCTION ensure_document_evidence_source_is_current() RETURNS trigger AS $$
BEGIN
  IF NEW.source_kind = 'document_snapshot' AND NOT EXISTS (
    SELECT 1
    FROM document_snapshots snapshot
    JOIN artifact_states state
      ON state.tenant_id=snapshot.tenant_id AND state.artifact_id=snapshot.artifact_id
    WHERE snapshot.tenant_id=NEW.tenant_id
      AND snapshot.id=NEW.source->>'documentSnapshotId'
      AND snapshot.artifact_id=NEW.source->>'artifactId'
      AND snapshot.content_sha256=NEW.source->>'snapshotSha256'
      AND snapshot.resource_scope=NEW.resource_scope
      AND snapshot.data_class=NEW.data_class
      AND NEW.audience='conversation:' || snapshot.conversation_id
      AND state.availability='active'
      AND state.integrity='verified'
      AND state.retention_status='active'
      AND state.retention_expires_at > now()
      AND state.reconcile_status='in_sync'
  ) THEN
    RAISE EXCEPTION 'document evidence must reference a current verified snapshot in the same scope';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_items_source_guard ON evidence_items;
CREATE CONSTRAINT TRIGGER evidence_items_source_guard AFTER INSERT OR UPDATE ON evidence_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_document_evidence_source_is_current();

CREATE TABLE IF NOT EXISTS evidence_links (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  claim_id text NOT NULL,
  evidence_id text NOT NULL,
  relation text NOT NULL CHECK (relation='supports'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,claim_id,evidence_id,relation),
  FOREIGN KEY (tenant_id,claim_id,business_task_id) REFERENCES claims(tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,evidence_id,business_task_id) REFERENCES evidence_items(tenant_id,id,business_task_id)
);

CREATE TABLE IF NOT EXISTS lineage_records (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  from_kind text NOT NULL,
  from_id text NOT NULL,
  to_kind text NOT NULL,
  to_id text NOT NULL,
  relation text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id,from_kind,from_id,to_kind,to_id,relation),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  CHECK (length(from_kind) BETWEEN 1 AND 80),
  CHECK (length(from_id) BETWEEN 1 AND 300),
  CHECK (length(to_kind) BETWEEN 1 AND 80),
  CHECK (length(to_id) BETWEEN 1 AND 300),
  CHECK (length(relation) BETWEEN 1 AND 80)
);

CREATE TABLE IF NOT EXISTS report_publish_intents (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  execution_attempt_id text NOT NULL,
  candidate_id text NOT NULL,
  source_document_snapshot_id text NOT NULL,
  root_artifact_id text NOT NULL,
  conversation_id text NOT NULL,
  owner_user_id text NOT NULL,
  resource_scope text NOT NULL,
  data_class text NOT NULL CHECK (data_class='C1'),
  audience text NOT NULL,
  artifact_id text NOT NULL,
  manifest_id text NOT NULL,
  storage_bucket text NOT NULL,
  storage_key text NOT NULL,
  template_id text NOT NULL CHECK (template_id='gate0.2a-report/v1'),
  template_sha256 text NOT NULL CHECK (template_sha256 ~ '^[a-f0-9]{64}$'),
  render_input_sha256 text NOT NULL CHECK (render_input_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('prepared','object_verified','published','reconcile_required')),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  etag_observed text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_task_id),
  UNIQUE (tenant_id,artifact_id),
  UNIQUE (tenant_id,manifest_id),
  UNIQUE (tenant_id,storage_bucket,storage_key),
  FOREIGN KEY (tenant_id,business_task_id) REFERENCES business_tasks(tenant_id,id),
  FOREIGN KEY (tenant_id,execution_attempt_id,business_task_id)
    REFERENCES execution_attempts(tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,candidate_id,business_task_id)
    REFERENCES attempt_output_candidates(tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,source_document_snapshot_id) REFERENCES document_snapshots(tenant_id,id),
  FOREIGN KEY (tenant_id,root_artifact_id) REFERENCES artifacts(tenant_id,id),
  FOREIGN KEY (tenant_id,business_task_id,conversation_id,owner_user_id)
    REFERENCES business_tasks(tenant_id,id,conversation_id,requester_id),
  CHECK (resource_scope='artifact:' || root_artifact_id),
  CHECK (audience='conversation:' || conversation_id),
  CHECK (
    (status='prepared' AND failure_code IS NULL)
    OR (status IN ('object_verified','published') AND failure_code IS NULL AND etag_observed IS NOT NULL)
    OR (status='reconcile_required' AND failure_code IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION enforce_report_publish_intent_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'prepared' OR NEW.state_version <> 1 THEN
      RAISE EXCEPTION 'report publish intent must start at prepared version 1';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'report publish intents cannot be deleted';
  END IF;

  IF ROW(
    NEW.tenant_id,NEW.id,NEW.business_task_id,NEW.execution_attempt_id,NEW.candidate_id,
    NEW.source_document_snapshot_id,NEW.root_artifact_id,NEW.conversation_id,NEW.owner_user_id,
    NEW.resource_scope,NEW.data_class,NEW.audience,NEW.artifact_id,NEW.manifest_id,
    NEW.storage_bucket,NEW.storage_key,NEW.template_id,NEW.template_sha256,
    NEW.render_input_sha256,NEW.size_bytes,NEW.content_sha256,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id,OLD.id,OLD.business_task_id,OLD.execution_attempt_id,OLD.candidate_id,
    OLD.source_document_snapshot_id,OLD.root_artifact_id,OLD.conversation_id,OLD.owner_user_id,
    OLD.resource_scope,OLD.data_class,OLD.audience,OLD.artifact_id,OLD.manifest_id,
    OLD.storage_bucket,OLD.storage_key,OLD.template_id,OLD.template_sha256,
    OLD.render_input_sha256,OLD.size_bytes,OLD.content_sha256,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'report publish intent identity is immutable';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'report publish intent state version must advance by one';
  END IF;
  IF NOT (
    (OLD.status='prepared' AND NEW.status IN ('object_verified','reconcile_required'))
    OR (OLD.status='object_verified' AND NEW.status IN ('published','reconcile_required'))
    OR (OLD.status='reconcile_required' AND NEW.status='object_verified')
  ) THEN
    RAISE EXCEPTION 'invalid report publish intent transition from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_publish_intents_transition_guard ON report_publish_intents;
CREATE TRIGGER report_publish_intents_transition_guard BEFORE INSERT OR UPDATE OR DELETE ON report_publish_intents
FOR EACH ROW EXECUTE FUNCTION enforce_report_publish_intent_transition();

CREATE OR REPLACE FUNCTION ensure_published_report_is_verified() RETURNS trigger AS $$
BEGIN
  IF NEW.status='published' AND NOT EXISTS (
    SELECT 1
    FROM artifacts artifact
    JOIN artifact_manifests manifest
      ON manifest.tenant_id=artifact.tenant_id AND manifest.artifact_id=artifact.id
    JOIN artifact_states state
      ON state.tenant_id=artifact.tenant_id AND state.artifact_id=artifact.id
    JOIN document_snapshots source_snapshot
      ON source_snapshot.tenant_id=NEW.tenant_id AND source_snapshot.id=NEW.source_document_snapshot_id
    JOIN artifact_states source_state
      ON source_state.tenant_id=source_snapshot.tenant_id AND source_state.artifact_id=source_snapshot.artifact_id
    JOIN execution_attempts attempt
      ON attempt.tenant_id=NEW.tenant_id AND attempt.id=NEW.execution_attempt_id
    JOIN attempt_output_candidates candidate
      ON candidate.tenant_id=NEW.tenant_id AND candidate.id=NEW.candidate_id
    JOIN business_tasks task
      ON task.tenant_id=NEW.tenant_id AND task.id=NEW.business_task_id
    WHERE artifact.tenant_id=NEW.tenant_id
      AND artifact.id=NEW.artifact_id
      AND artifact.kind='simulation_report'
      AND artifact.business_task_id=NEW.business_task_id
      AND artifact.root_artifact_id=NEW.root_artifact_id
      AND artifact.conversation_id=NEW.conversation_id
      AND artifact.owner_user_id=NEW.owner_user_id
      AND artifact.resource_scope=NEW.resource_scope
      AND artifact.data_class=NEW.data_class
      AND artifact.audience=jsonb_build_object('kind','private-conversation','conversationId',NEW.conversation_id)
      AND artifact.size_bytes=NEW.size_bytes
      AND artifact.content_sha256=NEW.content_sha256
      AND manifest.id=NEW.manifest_id
      AND manifest.storage_bucket=NEW.storage_bucket
      AND manifest.storage_key=NEW.storage_key
      AND manifest.size_bytes=NEW.size_bytes
      AND manifest.content_sha256=NEW.content_sha256
      AND source_snapshot.artifact_id=NEW.root_artifact_id
      AND source_snapshot.conversation_id=NEW.conversation_id
      AND source_state.availability='active'
      AND source_state.integrity='verified'
      AND source_state.retention_status='active'
      AND source_state.retention_expires_at > now()
      AND source_state.reconcile_status='in_sync'
      AND attempt.business_task_id=NEW.business_task_id
      AND attempt.status='completed'
      AND candidate.business_task_id=NEW.business_task_id
      AND candidate.execution_attempt_id=NEW.execution_attempt_id
      AND candidate.execution_version=attempt.execution_version
      AND candidate.fencing_token=attempt.fencing_token
      AND task.current_execution_attempt_id=attempt.id
      AND task.execution_version=attempt.execution_version
      AND task.execution_fencing_token=attempt.fencing_token
      AND task.status='completed'
      AND state.availability='active'
      AND state.integrity='verified'
      AND state.retention_status='active'
      AND state.retention_expires_at > now()
      AND state.reconcile_status='in_sync'
  ) THEN
    RAISE EXCEPTION 'published report intent requires a matching verified report artifact and manifest';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS report_publish_intents_publish_guard ON report_publish_intents;
CREATE CONSTRAINT TRIGGER report_publish_intents_publish_guard AFTER INSERT OR UPDATE ON report_publish_intents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_published_report_is_verified();

INSERT INTO evidence_items
  (tenant_id,id,business_task_id,source_kind,source,source_excerpt,excerpt_sha256,resource_scope,data_class,audience,
   accessible,simulation,runtime_mode,business_decision_allowed,created_at)
SELECT e.tenant_id,e.id,e.business_task_id,'legacy_fixture',jsonb_build_object(
  'kind','legacy_fixture','fixtureRef','fixture:solution-analysis:v1','fixtureVersion',1,
  'sourceId',e.source_id,'excerptSha256',e.source_hash
),e.source_excerpt,e.source_hash,e.resource_scope,e.data_class,
  'conversation:' || t.conversation_id,e.accessible,e.simulation,e.runtime_mode,e.business_decision_allowed,e.created_at
FROM minimal_evidence_refs e JOIN business_tasks t
  ON t.tenant_id=e.tenant_id AND t.id=e.business_task_id
ON CONFLICT DO NOTHING;

INSERT INTO claims
  (tenant_id,id,business_task_id,text,status,rejection_code,resource_scope,data_class,audience,
   simulation,runtime_mode,business_decision_allowed,created_at)
SELECT c.tenant_id,c.id,c.business_task_id,c.text,c.status,c.rejection_code,
  COALESCE(e.resource_scope,(t.permission_scope->'resourceScopes'->>0),'fixture:solution-analysis:v1'),
  COALESCE(e.data_class,'C1'),'conversation:' || t.conversation_id,
  c.simulation,c.runtime_mode,c.business_decision_allowed,c.created_at
FROM result_claims c JOIN business_tasks t
  ON t.tenant_id=c.tenant_id AND t.id=c.business_task_id
LEFT JOIN minimal_evidence_refs e
  ON e.tenant_id=c.tenant_id AND e.id=c.evidence_ref_id
ON CONFLICT DO NOTHING;

INSERT INTO evidence_links (tenant_id,id,business_task_id,claim_id,evidence_id,relation,created_at)
SELECT c.tenant_id,'legacy_link:' || c.id,c.business_task_id,c.id,c.evidence_ref_id,'supports',c.created_at
FROM result_claims c WHERE c.status='published' AND c.evidence_ref_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO lineage_records (tenant_id,id,business_task_id,from_kind,from_id,to_kind,to_id,relation,metadata,created_at)
SELECT e.tenant_id,'legacy_lineage:evidence:' || e.id,e.business_task_id,
  'legacy_fixture',e.source_id,'evidence',e.id,'legacy_fixture',jsonb_build_object('sourceHash',e.source_hash),e.created_at
FROM minimal_evidence_refs e ON CONFLICT DO NOTHING;

INSERT INTO lineage_records (tenant_id,id,business_task_id,from_kind,from_id,to_kind,to_id,relation,metadata,created_at)
SELECT c.tenant_id,'legacy_lineage:claim:' || c.id,c.business_task_id,
  'evidence',c.evidence_ref_id,'claim',c.id,'supports','{}'::jsonb,c.created_at
FROM result_claims c
WHERE c.evidence_ref_id IS NOT NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM minimal_evidence_refs legacy
    LEFT JOIN evidence_items current
      ON current.tenant_id=legacy.tenant_id AND current.id=legacy.id
    WHERE current.id IS NULL
      OR current.business_task_id IS DISTINCT FROM legacy.business_task_id
      OR current.source_kind IS DISTINCT FROM 'legacy_fixture'
      OR current.source->>'sourceId' IS DISTINCT FROM legacy.source_id
      OR current.source_excerpt IS DISTINCT FROM legacy.source_excerpt
      OR current.excerpt_sha256 IS DISTINCT FROM legacy.source_hash
      OR current.resource_scope IS DISTINCT FROM legacy.resource_scope
      OR current.data_class IS DISTINCT FROM legacy.data_class
      OR current.accessible IS DISTINCT FROM legacy.accessible
  ) THEN
    RAISE EXCEPTION 'legacy evidence backfill did not preserve authoritative fields';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM result_claims legacy
    LEFT JOIN claims current
      ON current.tenant_id=legacy.tenant_id AND current.id=legacy.id
    WHERE current.id IS NULL
      OR current.business_task_id IS DISTINCT FROM legacy.business_task_id
      OR current.text IS DISTINCT FROM legacy.text
      OR current.status IS DISTINCT FROM legacy.status
      OR current.rejection_code IS DISTINCT FROM legacy.rejection_code
  ) THEN
    RAISE EXCEPTION 'legacy claim backfill did not preserve authoritative fields';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM result_claims legacy
    LEFT JOIN evidence_links link
      ON link.tenant_id=legacy.tenant_id
      AND link.claim_id=legacy.id
      AND link.evidence_id=legacy.evidence_ref_id
      AND link.relation='supports'
    LEFT JOIN evidence_items evidence
      ON evidence.tenant_id=link.tenant_id AND evidence.id=link.evidence_id
    WHERE legacy.status='published'
      AND (link.id IS NULL OR evidence.id IS NULL OR NOT evidence.accessible)
  ) THEN
    RAISE EXCEPTION 'legacy published claim lacks an accessible same-task supports evidence link';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION reject_legacy_result_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legacy result tables are read-only after Gate 0.2A roll-forward';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS result_claims_legacy_read_only ON result_claims;
CREATE TRIGGER result_claims_legacy_read_only BEFORE INSERT OR UPDATE OR DELETE ON result_claims
FOR EACH ROW EXECUTE FUNCTION reject_legacy_result_write();
DROP TRIGGER IF EXISTS minimal_evidence_refs_legacy_read_only ON minimal_evidence_refs;
CREATE TRIGGER minimal_evidence_refs_legacy_read_only BEFORE INSERT OR UPDATE OR DELETE ON minimal_evidence_refs
FOR EACH ROW EXECUTE FUNCTION reject_legacy_result_write();

CREATE OR REPLACE FUNCTION ensure_published_claim_has_evidence() RETURNS trigger AS $$
DECLARE
  checked_tenant text;
  checked_claim text;
BEGIN
  checked_tenant := COALESCE(NEW.tenant_id,OLD.tenant_id);
  IF TG_TABLE_NAME='claims' THEN
    checked_claim := COALESCE(NEW.id,OLD.id);
  ELSE
    checked_claim := COALESCE(NEW.claim_id,OLD.claim_id);
  END IF;
  IF EXISTS (SELECT 1 FROM claims c WHERE c.tenant_id=checked_tenant AND c.id=checked_claim AND c.status='published')
     AND NOT EXISTS (
       SELECT 1 FROM evidence_links l
       JOIN claims c ON c.tenant_id=l.tenant_id AND c.id=l.claim_id AND c.business_task_id=l.business_task_id
       JOIN evidence_items e ON e.tenant_id=l.tenant_id AND e.id=l.evidence_id AND e.business_task_id=l.business_task_id
       WHERE l.tenant_id=checked_tenant AND l.claim_id=checked_claim AND l.relation='supports' AND e.accessible
     ) THEN
    RAISE EXCEPTION 'published claim requires a same-task accessible supports evidence link';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS claims_support_guard ON claims;
CREATE CONSTRAINT TRIGGER claims_support_guard AFTER INSERT OR UPDATE OR DELETE ON claims
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_published_claim_has_evidence();
DROP TRIGGER IF EXISTS evidence_links_support_guard ON evidence_links;
CREATE CONSTRAINT TRIGGER evidence_links_support_guard AFTER INSERT OR UPDATE OR DELETE ON evidence_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_published_claim_has_evidence();

DROP TRIGGER IF EXISTS outbox_events_append_only ON outbox_events;
CREATE TRIGGER outbox_events_append_only BEFORE UPDATE OR DELETE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION reject_task_event_update();
DROP TRIGGER IF EXISTS attempt_output_candidates_immutable ON attempt_output_candidates;
CREATE TRIGGER attempt_output_candidates_immutable BEFORE UPDATE OR DELETE ON attempt_output_candidates
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS claims_immutable ON claims;
CREATE TRIGGER claims_immutable BEFORE UPDATE OR DELETE ON claims
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS evidence_items_immutable ON evidence_items;
CREATE TRIGGER evidence_items_immutable BEFORE UPDATE OR DELETE ON evidence_items
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS evidence_links_immutable ON evidence_links;
CREATE TRIGGER evidence_links_immutable BEFORE UPDATE OR DELETE ON evidence_links
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
DROP TRIGGER IF EXISTS lineage_records_immutable ON lineage_records;
CREATE TRIGGER lineage_records_immutable BEFORE UPDATE OR DELETE ON lineage_records
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

-- Flush the deferred source checks queued by the legacy evidence backfill before
-- PostgreSQL builds indexes on evidence_items in this same migration transaction.
SET CONSTRAINTS evidence_items_source_guard IMMEDIATE;

CREATE INDEX IF NOT EXISTS execution_attempts_task_idx ON execution_attempts (tenant_id,business_task_id,status);
CREATE INDEX IF NOT EXISTS outbox_deliveries_lease_idx ON outbox_deliveries (consumer,status,lease_until);
CREATE INDEX IF NOT EXISTS claims_task_idx ON claims (tenant_id,business_task_id,status,created_at);
CREATE INDEX IF NOT EXISTS evidence_task_idx ON evidence_items (tenant_id,business_task_id,created_at);
CREATE INDEX IF NOT EXISTS lineage_task_idx ON lineage_records (tenant_id,business_task_id,created_at);
