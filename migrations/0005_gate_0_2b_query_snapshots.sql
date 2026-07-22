CREATE TABLE IF NOT EXISTS query_snapshots (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  principal_id text NOT NULL,
  query_kind text NOT NULL CHECK (query_kind IN ('business_tasks', 'workflow_versions')),
  authorization_epoch text NOT NULL CHECK (authorization_epoch ~ '^[a-f0-9]{64}$'),
  canonical_query jsonb NOT NULL,
  query_version text NOT NULL CHECK (length(query_version) BETWEEN 1 AND 100),
  field_mask_version text NOT NULL CHECK (length(field_mask_version) BETWEEN 1 AND 100),
  as_of timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES users(tenant_id, id),
  CHECK (expires_at > as_of AND expires_at <= as_of + interval '15 minutes')
);

CREATE TABLE IF NOT EXISTS query_snapshot_items (
  tenant_id text NOT NULL,
  query_snapshot_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  object_id text NOT NULL,
  sort_key jsonb NOT NULL,
  PRIMARY KEY (tenant_id, query_snapshot_id, position),
  UNIQUE (tenant_id, query_snapshot_id, object_id),
  FOREIGN KEY (tenant_id, query_snapshot_id) REFERENCES query_snapshots(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS query_snapshots_expiry_idx
  ON query_snapshots (expires_at);

CREATE INDEX IF NOT EXISTS query_snapshot_items_object_idx
  ON query_snapshot_items (tenant_id, query_snapshot_id, object_id);

CREATE INDEX IF NOT EXISTS business_tasks_requester_updated_idx
  ON business_tasks (tenant_id, requester_id, updated_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS business_tasks_requester_created_idx
  ON business_tasks (tenant_id, requester_id, created_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS business_tasks_requester_workflow_idx
  ON business_tasks (tenant_id, requester_id, workflow_version_id);

CREATE INDEX IF NOT EXISTS workflow_versions_created_idx
  ON workflow_versions (tenant_id, created_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (tenant_id, conversation_id, created_at, id);

CREATE OR REPLACE FUNCTION geneway_reject_query_snapshot_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'query snapshots are immutable';
END;
$$;

DROP TRIGGER IF EXISTS query_snapshots_immutable ON query_snapshots;
CREATE TRIGGER query_snapshots_immutable
  BEFORE UPDATE ON query_snapshots
  FOR EACH ROW EXECUTE FUNCTION geneway_reject_query_snapshot_update();

DROP TRIGGER IF EXISTS query_snapshot_items_immutable ON query_snapshot_items;
CREATE TRIGGER query_snapshot_items_immutable
  BEFORE UPDATE ON query_snapshot_items
  FOR EACH ROW EXECUTE FUNCTION geneway_reject_query_snapshot_update();
