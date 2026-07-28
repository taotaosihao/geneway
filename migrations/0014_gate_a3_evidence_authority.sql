-- Gate A A.3 connector Evidence current-access and terminal publication
-- authority. Source snapshots and Evidence remain immutable facts; revocation is
-- a separate append-only fact evaluated on every model/public-read boundary.

ALTER TABLE gate_a3_connector_source_snapshots
  ADD CONSTRAINT gate_a3_connector_source_snapshots_task_identity_uq
  UNIQUE (tenant_id,id,business_task_id);

CREATE TABLE gate_a3_connector_source_revocations (
  tenant_id text NOT NULL,
  id text NOT NULL,
  business_task_id text NOT NULL,
  connector_source_snapshot_id text NOT NULL,
  principal_id text NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[a-f0-9]{64}$'),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,connector_source_snapshot_id,principal_id),
  FOREIGN KEY (tenant_id,connector_source_snapshot_id,business_task_id)
    REFERENCES gate_a3_connector_source_snapshots(tenant_id,id,business_task_id),
  FOREIGN KEY (tenant_id,business_task_id)
    REFERENCES business_tasks(tenant_id,id)
);

CREATE OR REPLACE FUNCTION validate_gate_a3_connector_source_revocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot_audience text;
  task_requester text;
  task_variant text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('gate-a3-source-access:' || NEW.tenant_id),
    hashtext(NEW.connector_source_snapshot_id || ':' || NEW.principal_id)
  );
  SELECT snapshot.audience,task.requester_id,task.record_variant
    INTO snapshot_audience,task_requester,task_variant
    FROM gate_a3_connector_source_snapshots snapshot
    JOIN business_tasks task
      ON task.tenant_id=snapshot.tenant_id AND task.id=snapshot.business_task_id
    WHERE snapshot.tenant_id=NEW.tenant_id
      AND snapshot.id=NEW.connector_source_snapshot_id
      AND snapshot.business_task_id=NEW.business_task_id;
  IF task_variant IS DISTINCT FROM 'business-task.work-order.live/1'
    OR task_requester IS DISTINCT FROM NEW.principal_id
    OR snapshot_audience IS DISTINCT FROM 'principal:' || NEW.principal_id THEN
    RAISE EXCEPTION 'Gate A.3 source revocation must bind the snapshot requester and audience';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_a3_connector_source_revocations_validate
  BEFORE INSERT ON gate_a3_connector_source_revocations
  FOR EACH ROW EXECUTE FUNCTION validate_gate_a3_connector_source_revocation();
CREATE TRIGGER gate_a3_connector_source_revocations_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_connector_source_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE INDEX gate_a3_connector_source_revocations_lookup_idx
  ON gate_a3_connector_source_revocations
    (tenant_id,connector_source_snapshot_id,principal_id,revoked_at);

CREATE OR REPLACE FUNCTION guard_gate_a3_terminal_task_result_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.record_variant='business-task.work-order.live/1'
    AND OLD.status IN ('completed','failed','canceled')
    AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.result IS DISTINCT FROM OLD.result
      OR NEW.result_record_variant IS DISTINCT FROM OLD.result_record_variant
      OR NEW.terminal_error_class IS DISTINCT FROM OLD.terminal_error_class
      OR NEW.record_variant IS DISTINCT FROM OLD.record_variant
      OR NEW.semantic_fingerprint IS DISTINCT FROM OLD.semantic_fingerprint) THEN
    RAISE EXCEPTION 'terminal Gate A.3 task result authority is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_a3_terminal_task_result_immutable
  BEFORE UPDATE ON business_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_gate_a3_terminal_task_result_immutable();
