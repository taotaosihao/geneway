CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  display_name text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS roles (
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id text NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (tenant_id, user_id, role),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS resource_scopes (
  tenant_id text NOT NULL REFERENCES tenants(id),
  user_id text NOT NULL,
  resource_scope text NOT NULL,
  PRIMARY KEY (tenant_id, user_id, resource_scope),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS conversations (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  tenant_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL,
  author text NOT NULL CHECK (author IN ('user', 'xiaowei')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS capability_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  capability_id text NOT NULL,
  version integer NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, capability_id, version)
);

CREATE TABLE IF NOT EXISTS expert_catalog_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  version integer NOT NULL,
  catalog jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS harness_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  capability_version_id text NOT NULL,
  version integer NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, capability_version_id) REFERENCES capability_versions(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  workflow_hash text NOT NULL,
  canonicalization_version text NOT NULL,
  canonical_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, workflow_hash)
);

CREATE TABLE IF NOT EXISTS business_tasks (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  conversation_id text NOT NULL,
  capability_version_id text NOT NULL,
  expert_catalog_version_id text NOT NULL,
  harness_version_id text NOT NULL,
  workflow_version_id text NOT NULL,
  workflow_hash text NOT NULL,
  requester_id text NOT NULL,
  status text NOT NULL,
  input_snapshot jsonb NOT NULL,
  expert_target jsonb NOT NULL,
  permission_scope jsonb NOT NULL,
  audience_scope jsonb NOT NULL,
  budget jsonb NOT NULL,
  simulation boolean NOT NULL CHECK (simulation),
  runtime_mode text NOT NULL CHECK (runtime_mode = 'fake'),
  business_decision_allowed boolean NOT NULL CHECK (NOT business_decision_allowed),
  aggregate_version bigint NOT NULL DEFAULT 1,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
  FOREIGN KEY (tenant_id, capability_version_id) REFERENCES capability_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, expert_catalog_version_id) REFERENCES expert_catalog_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, harness_version_id) REFERENCES harness_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_version_id) REFERENCES workflow_versions(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS business_task_events (
  cursor bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  aggregate_version bigint NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  payload jsonb NOT NULL,
  simulation boolean NOT NULL CHECK (simulation),
  runtime_mode text NOT NULL CHECK (runtime_mode = 'fake'),
  business_decision_allowed boolean NOT NULL CHECK (NOT business_decision_allowed),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, business_task_id, sequence),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS business_task_steps (
  tenant_id text NOT NULL,
  business_task_id text NOT NULL,
  step_id text NOT NULL,
  status text NOT NULL,
  attempt_id text,
  fencing_token bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  output jsonb,
  simulation boolean NOT NULL CHECK (simulation),
  runtime_mode text NOT NULL CHECK (runtime_mode = 'fake'),
  business_decision_allowed boolean NOT NULL CHECK (NOT business_decision_allowed),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, business_task_id, step_id),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS approval_versions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  version integer NOT NULL,
  subject jsonb NOT NULL,
  subject_digest text NOT NULL,
  status text NOT NULL,
  requester_id text NOT NULL,
  approver_policy_version text NOT NULL,
  decision_by text,
  decision_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, business_task_id, version),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS delegated_capabilities (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  principal_id text NOT NULL,
  allowed_actions jsonb NOT NULL,
  resource_scopes jsonb NOT NULL,
  audience_scope jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  allow boolean NOT NULL,
  reason_codes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS minimal_evidence_refs (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  source_id text NOT NULL,
  source_excerpt text NOT NULL,
  source_hash text NOT NULL,
  resource_scope text NOT NULL,
  data_class text NOT NULL,
  accessible boolean NOT NULL,
  simulation boolean NOT NULL CHECK (simulation),
  runtime_mode text NOT NULL CHECK (runtime_mode = 'fake'),
  business_decision_allowed boolean NOT NULL CHECK (NOT business_decision_allowed),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS result_claims (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  text text NOT NULL,
  status text NOT NULL,
  evidence_ref_id text,
  rejection_code text,
  simulation boolean NOT NULL CHECK (simulation),
  runtime_mode text NOT NULL CHECK (runtime_mode = 'fake'),
  business_decision_allowed boolean NOT NULL CHECK (NOT business_decision_allowed),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_ref_id) REFERENCES minimal_evidence_refs(tenant_id, id),
  CHECK ((status = 'published' AND evidence_ref_id IS NOT NULL AND rejection_code IS NULL)
      OR (status = 'rejected' AND evidence_ref_id IS NULL AND rejection_code IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS outbox_events (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, business_task_id) REFERENCES business_tasks(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id text NOT NULL REFERENCES tenants(id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation, idempotency_key)
);

CREATE OR REPLACE FUNCTION reject_immutable_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable version rows cannot be updated';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_versions_immutable ON workflow_versions;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE OR DELETE ON workflow_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

DROP TRIGGER IF EXISTS capability_versions_immutable ON capability_versions;
CREATE TRIGGER capability_versions_immutable BEFORE UPDATE OR DELETE ON capability_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

DROP TRIGGER IF EXISTS expert_catalog_versions_immutable ON expert_catalog_versions;
CREATE TRIGGER expert_catalog_versions_immutable BEFORE UPDATE OR DELETE ON expert_catalog_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

DROP TRIGGER IF EXISTS harness_versions_immutable ON harness_versions;
CREATE TRIGGER harness_versions_immutable BEFORE UPDATE OR DELETE ON harness_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE OR REPLACE FUNCTION reject_task_event_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'business task events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS business_task_events_append_only ON business_task_events;
CREATE TRIGGER business_task_events_append_only BEFORE UPDATE OR DELETE ON business_task_events
FOR EACH ROW EXECUTE FUNCTION reject_task_event_update();

INSERT INTO tenants (id, name) VALUES ('tenant_local', '本机演示租户') ON CONFLICT DO NOTHING;
INSERT INTO users (tenant_id, id, display_name) VALUES ('tenant_local', 'user_local', '本机用户') ON CONFLICT DO NOTHING;
INSERT INTO roles (tenant_id, user_id, role) VALUES ('tenant_local', 'user_local', 'solution_reviewer') ON CONFLICT DO NOTHING;
INSERT INTO resource_scopes (tenant_id, user_id, resource_scope) VALUES ('tenant_local', 'user_local', 'fixture:solution-analysis:v1') ON CONFLICT DO NOTHING;
