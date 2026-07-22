-- Gate 0.2A.3 keeps one mutable delivery/inbox identity per outbox event while
-- allowing a crashed execution lease to move to a new fenced attempt.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='execution_attempts'::regclass AND contype='u'
    AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, business_task_id, execution_version)';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE execution_attempts DROP CONSTRAINT %I',constraint_name);
  END IF;

  constraint_name := NULL;
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='execution_attempts'::regclass AND contype='u'
    AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, consumer, source_event_id)';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE execution_attempts DROP CONSTRAINT %I',constraint_name);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS execution_attempts_execution_idx
  ON execution_attempts(tenant_id,business_task_id,execution_version,started_at);
CREATE INDEX IF NOT EXISTS execution_attempts_source_event_idx
  ON execution_attempts(tenant_id,consumer,source_event_id,started_at);

ALTER TABLE execution_attempts DROP CONSTRAINT IF EXISTS execution_attempts_status_check;
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_status_check
  CHECK (status IN ('running','completed','failed','canceled','superseded'));
ALTER TABLE execution_attempts DROP CONSTRAINT IF EXISTS execution_attempts_check;
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_terminal_time_check CHECK (
  (status='running' AND completed_at IS NULL)
  OR (status IN ('completed','failed','canceled','superseded') AND completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_one_running_task_idx
  ON execution_attempts(tenant_id,business_task_id) WHERE status='running';
CREATE UNIQUE INDEX IF NOT EXISTS execution_attempts_one_running_event_idx
  ON execution_attempts(tenant_id,consumer,source_event_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS business_task_events_task_cursor_idx
  ON business_task_events(tenant_id,business_task_id,cursor);

ALTER TABLE report_publish_intents ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE report_publish_intents DROP CONSTRAINT IF EXISTS report_publish_intents_status_check;
ALTER TABLE report_publish_intents ADD CONSTRAINT report_publish_intents_status_check CHECK (
  status IN ('prepared','object_verified','published','reconcile_required','put_failed_confirmed','integrity_error','delete_pending','deleted')
);
-- 0003 originally used three anonymous checks. PostgreSQL assigned them
-- check/check1/check2, but generated names are not a stable migration API.
-- Replace the resource, audience, and state checks by inspecting definitions,
-- then give every invariant an explicit name.
DO $$
DECLARE candidate record;
BEGIN
  FOR candidate IN
    SELECT conname,lower(pg_get_constraintdef(oid)) definition
    FROM pg_constraint
    WHERE conrelid='report_publish_intents'::regclass AND contype='c'
  LOOP
    IF (candidate.definition LIKE '%resource_scope%' AND candidate.definition LIKE '%root_artifact_id%')
      OR (candidate.definition LIKE '%audience%' AND candidate.definition LIKE '%conversation_id%')
      OR (candidate.definition LIKE '%failure_code%' AND candidate.definition LIKE '%status%') THEN
      EXECUTE format('ALTER TABLE report_publish_intents DROP CONSTRAINT %I',candidate.conname);
    END IF;
  END LOOP;
END;
$$;
ALTER TABLE report_publish_intents ADD CONSTRAINT report_publish_intents_resource_scope_check
  CHECK (resource_scope='artifact:' || root_artifact_id);
ALTER TABLE report_publish_intents ADD CONSTRAINT report_publish_intents_audience_check
  CHECK (audience='conversation:' || conversation_id);
ALTER TABLE report_publish_intents ADD CONSTRAINT report_publish_intents_state_check CHECK (
  (status='prepared' AND failure_code IS NULL AND deleted_at IS NULL)
  OR (status IN ('object_verified','published') AND failure_code IS NULL AND deleted_at IS NULL)
  OR (status IN ('reconcile_required','put_failed_confirmed','integrity_error','delete_pending') AND failure_code IS NOT NULL AND deleted_at IS NULL)
  OR (status='deleted' AND failure_code IS NOT NULL AND deleted_at IS NOT NULL)
);

ALTER TABLE inbox_events DROP CONSTRAINT IF EXISTS inbox_events_status_check;
ALTER TABLE inbox_events ADD CONSTRAINT inbox_events_status_check
  CHECK (status IN ('received','processing','completed','failed','canceled'));
ALTER TABLE inbox_events DROP CONSTRAINT IF EXISTS inbox_events_check;
ALTER TABLE inbox_events ADD CONSTRAINT inbox_events_terminal_time_check CHECK (
  (status='received' AND processing_at IS NULL AND completed_at IS NULL)
  OR (status='processing' AND processing_at IS NOT NULL AND completed_at IS NULL)
  OR (status IN ('completed','failed') AND processing_at IS NOT NULL AND completed_at IS NOT NULL)
  OR (status='canceled' AND completed_at IS NOT NULL)
);

-- An object may have been verified immediately before a Worker crash. The
-- deterministic report intent can be adopted by the new current attempt only
-- when its immutable content identity is unchanged. This avoids a second key.
CREATE OR REPLACE FUNCTION enforce_report_publish_intent_transition() RETURNS trigger AS $$
DECLARE adoption_only boolean;
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

  adoption_only :=
    NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
    AND NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
    AND NEW.status=OLD.status
    AND NEW.state_version=OLD.state_version+1
    AND NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code
    AND NEW.etag_observed IS NOT DISTINCT FROM OLD.etag_observed;

  IF ROW(
    NEW.tenant_id,NEW.id,NEW.business_task_id,
    NEW.source_document_snapshot_id,NEW.root_artifact_id,NEW.conversation_id,NEW.owner_user_id,
    NEW.resource_scope,NEW.data_class,NEW.audience,NEW.artifact_id,NEW.manifest_id,
    NEW.storage_bucket,NEW.storage_key,NEW.template_id,NEW.template_sha256,
    NEW.render_input_sha256,NEW.size_bytes,NEW.content_sha256,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id,OLD.id,OLD.business_task_id,
    OLD.source_document_snapshot_id,OLD.root_artifact_id,OLD.conversation_id,OLD.owner_user_id,
    OLD.resource_scope,OLD.data_class,OLD.audience,OLD.artifact_id,OLD.manifest_id,
    OLD.storage_bucket,OLD.storage_key,OLD.template_id,OLD.template_sha256,
    OLD.render_input_sha256,OLD.size_bytes,OLD.content_sha256,OLD.created_at
  ) THEN
    RAISE EXCEPTION 'report publish intent identity is immutable';
  END IF;

  IF adoption_only THEN
    IF NEW.status NOT IN ('prepared','object_verified','reconcile_required','put_failed_confirmed') OR NOT EXISTS (
      SELECT 1
      FROM business_tasks task
      JOIN execution_attempts attempt
        ON attempt.tenant_id=task.tenant_id AND attempt.id=task.current_execution_attempt_id
      JOIN attempt_output_candidates candidate
        ON candidate.tenant_id=attempt.tenant_id AND candidate.execution_attempt_id=attempt.id
      WHERE task.tenant_id=NEW.tenant_id AND task.id=NEW.business_task_id
        AND task.status='running' AND attempt.id=NEW.execution_attempt_id
        AND task.execution_version=attempt.execution_version
        AND task.execution_fencing_token=attempt.fencing_token
        AND attempt.status='running' AND attempt.lease_until>now()
        AND candidate.id=NEW.candidate_id
        AND candidate.business_task_id=task.id
        AND candidate.execution_version=attempt.execution_version
        AND candidate.fencing_token=attempt.fencing_token
        AND candidate.worker_instance_id=attempt.worker_instance_id
        AND candidate.payload_sha256=(
          SELECT previous.payload_sha256 FROM attempt_output_candidates previous
          WHERE previous.tenant_id=OLD.tenant_id AND previous.id=OLD.candidate_id
        )
    ) THEN
      RAISE EXCEPTION 'report publish intent adoption is not authorized';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
    OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id THEN
    RAISE EXCEPTION 'report publish intent attempt identity may change only during adoption';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'report publish intent state version must advance by one';
  END IF;
  IF NOT (
    (OLD.status='prepared' AND NEW.status IN ('object_verified','reconcile_required','integrity_error'))
    OR (OLD.status='object_verified' AND NEW.status IN ('published','reconcile_required','integrity_error','delete_pending'))
    OR (OLD.status='reconcile_required' AND NEW.status IN ('object_verified','put_failed_confirmed','integrity_error','delete_pending'))
    OR (OLD.status='put_failed_confirmed' AND NEW.status IN ('prepared','delete_pending'))
    OR (OLD.status='integrity_error' AND NEW.status='delete_pending')
    OR (OLD.status='delete_pending' AND NEW.status='deleted')
  ) THEN
    RAISE EXCEPTION 'invalid report publish intent transition from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS storage_orphan_tombstones (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  storage_bucket text NOT NULL,
  storage_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  etag_observed text,
  reason_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('delete_pending','deleted')),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,storage_bucket,storage_key),
  CHECK ((status='delete_pending' AND deleted_at IS NULL) OR (status='deleted' AND deleted_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION enforce_storage_orphan_tombstone_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'delete_pending' OR NEW.state_version<>1 OR NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'orphan tombstone must start delete_pending at version 1';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'orphan tombstones cannot be deleted'; END IF;
  IF ROW(NEW.tenant_id,NEW.id,NEW.storage_bucket,NEW.storage_key,NEW.size_bytes,NEW.content_sha256,
         NEW.etag_observed,NEW.reason_code,NEW.discovered_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id,OLD.id,OLD.storage_bucket,OLD.storage_key,OLD.size_bytes,OLD.content_sha256,
         OLD.etag_observed,OLD.reason_code,OLD.discovered_at)
     OR OLD.status<>'delete_pending' OR NEW.status<>'deleted'
     OR NEW.state_version<>OLD.state_version+1 OR NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'invalid orphan tombstone transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS storage_orphan_tombstones_transition_guard ON storage_orphan_tombstones;
CREATE TRIGGER storage_orphan_tombstones_transition_guard
BEFORE INSERT OR UPDATE OR DELETE ON storage_orphan_tombstones
FOR EACH ROW EXECUTE FUNCTION enforce_storage_orphan_tombstone_transition();

-- A tombstone owns the decision to delete a key. Reference writers and the
-- reconciler take the same per-key advisory lock, so a reference cannot race
-- in after the last check and before object deletion.
CREATE OR REPLACE FUNCTION reject_tombstoned_storage_key() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.storage_bucket),hashtext(NEW.storage_key));
  IF EXISTS (
    SELECT 1 FROM storage_orphan_tombstones tombstone
    WHERE tombstone.tenant_id=NEW.tenant_id
      AND tombstone.storage_bucket=NEW.storage_bucket
      AND tombstone.storage_key=NEW.storage_key
  ) THEN
    RAISE EXCEPTION 'storage key is owned by an orphan tombstone';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_manifest_tombstone_guard ON artifact_manifests;
CREATE TRIGGER artifact_manifest_tombstone_guard
BEFORE INSERT OR UPDATE OF storage_bucket,storage_key ON artifact_manifests
FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_storage_key();

DROP TRIGGER IF EXISTS artifact_ingest_tombstone_guard ON artifact_ingest_intents;
CREATE TRIGGER artifact_ingest_tombstone_guard
BEFORE INSERT OR UPDATE OF storage_bucket,storage_key ON artifact_ingest_intents
FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_storage_key();

DROP TRIGGER IF EXISTS report_publish_tombstone_guard ON report_publish_intents;
CREATE TRIGGER report_publish_tombstone_guard
BEFORE INSERT OR UPDATE OF storage_bucket,storage_key ON report_publish_intents
FOR EACH ROW EXECUTE FUNCTION reject_tombstoned_storage_key();

CREATE TABLE IF NOT EXISTS backup_sets (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('preparing','sealed','restoring','verifying','open','failed')),
  source_cluster_id text NOT NULL,
  target_cluster_id text,
  checkpoint_lsn text,
  event_watermark bigint,
  object_inventory_sha256 text CHECK (object_inventory_sha256 IS NULL OR object_inventory_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_write_barriers (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  backup_set_id text NOT NULL REFERENCES backup_sets(id),
  active boolean NOT NULL,
  reads_blocked boolean NOT NULL DEFAULT false,
  writes_blocked boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (active AND writes_blocked)
);
