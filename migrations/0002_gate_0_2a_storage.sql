CREATE TABLE IF NOT EXISTS artifact_ingest_intents (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  conversation_id text NOT NULL,
  requester_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN (
    'intent_created','put_inflight','object_verified','ready','put_failed_confirmed','reconcile_required',
    'integrity_error','delete_pending','deleted'
  )),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  artifact_id text NOT NULL,
  manifest_id text NOT NULL,
  document_snapshot_id text NOT NULL,
  storage_bucket text NOT NULL,
  storage_key text NOT NULL,
  display_name text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain','text/markdown')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  extension text NOT NULL CHECK (extension IN ('txt','md')),
  simulation_profile text CHECK (simulation_profile IS NULL OR simulation_profile = 'solution-analysis-demo/v2'),
  profile_registry_version text NOT NULL CHECK (profile_registry_version = 'gate0.2a-profile-registry/1'),
  failure_code text,
  object_verified_at timestamptz,
  etag_observed text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,requester_id,idempotency_key),
  UNIQUE (tenant_id,artifact_id),
  UNIQUE (tenant_id,manifest_id),
  UNIQUE (tenant_id,document_snapshot_id),
  UNIQUE (tenant_id,storage_bucket,storage_key),
  FOREIGN KEY (tenant_id,requester_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  conversation_id text NOT NULL,
  owner_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind = 'source_document'),
  display_name text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain','text/markdown')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES users(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS artifact_manifests (
  tenant_id text NOT NULL,
  id text NOT NULL,
  artifact_id text NOT NULL,
  storage_bucket text NOT NULL,
  storage_key text NOT NULL,
  display_name text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain','text/markdown')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  retention_policy text NOT NULL CHECK (retention_policy = 'gate0.2a-internal/v1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,artifact_id),
  UNIQUE (tenant_id,storage_bucket,storage_key),
  FOREIGN KEY (tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS artifact_states (
  tenant_id text NOT NULL,
  artifact_id text NOT NULL,
  availability text NOT NULL CHECK (availability IN ('active','missing','retained','deleted')),
  integrity text NOT NULL CHECK (integrity IN ('pending','verified','failed')),
  retention_status text NOT NULL CHECK (retention_status IN ('active','expired','held','deleted')),
  retention_expires_at timestamptz NOT NULL,
  reconcile_status text NOT NULL CHECK (reconcile_status IN ('in_sync','required')),
  failure_code text,
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  etag_observed text,
  last_checked_at timestamptz,
  last_verified_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,artifact_id),
  FOREIGN KEY (tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS document_snapshots (
  tenant_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL,
  artifact_id text NOT NULL,
  manifest_id text NOT NULL,
  display_name text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain','text/markdown')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  data_class text NOT NULL CHECK (data_class = 'C1'),
  audience jsonb NOT NULL,
  resource_scope text NOT NULL,
  trust text NOT NULL CHECK (trust = 'untrusted_text'),
  simulation_profile text CHECK (simulation_profile IS NULL OR simulation_profile = 'solution-analysis-demo/v2'),
  profile_registry_version text NOT NULL CHECK (profile_registry_version = 'gate0.2a-profile-registry/1'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (resource_scope = 'artifact:' || artifact_id),
  CHECK (audience = jsonb_build_object('kind','private-conversation','conversationId',conversation_id)),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,artifact_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY (tenant_id,artifact_id) REFERENCES artifacts(tenant_id,id),
  FOREIGN KEY (tenant_id,manifest_id) REFERENCES artifact_manifests(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  cursor bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  principal_id text NOT NULL,
  event_type text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed','denied','failed')),
  reason_code text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);

CREATE INDEX IF NOT EXISTS artifact_intents_reconcile_idx
  ON artifact_ingest_intents (status,updated_at) WHERE status IN ('intent_created','put_inflight','object_verified','reconcile_required');
CREATE INDEX IF NOT EXISTS snapshots_conversation_idx
  ON document_snapshots (tenant_id,conversation_id,created_at,id);
CREATE INDEX IF NOT EXISTS audit_resource_idx
  ON audit_events (tenant_id,resource_type,resource_id,occurred_at);

DROP TRIGGER IF EXISTS artifacts_immutable ON artifacts;
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

DROP TRIGGER IF EXISTS artifact_manifests_immutable ON artifact_manifests;
CREATE TRIGGER artifact_manifests_immutable BEFORE UPDATE OR DELETE ON artifact_manifests
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

DROP TRIGGER IF EXISTS document_snapshots_immutable ON document_snapshots;
CREATE TRIGGER document_snapshots_immutable BEFORE UPDATE OR DELETE ON document_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_task_event_update();
