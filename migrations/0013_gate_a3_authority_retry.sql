-- Gate A A.3 authority linearization and connector retry durability.
-- Runtime checks take the shared capability lock; every authority mutation
-- takes the exclusive form before touching the current pointer or revocations.

CREATE OR REPLACE FUNCTION gate_a3_authority_exclusive_statement_lock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1196313667,3);
  RETURN NULL;
END $$;

CREATE TRIGGER gate_a3_authority_envelopes_exclusive_lock
  BEFORE INSERT ON gate_a3_authority_envelopes
  FOR EACH STATEMENT EXECUTE FUNCTION gate_a3_authority_exclusive_statement_lock();
CREATE TRIGGER gate_a3_authority_current_exclusive_lock
  BEFORE INSERT OR UPDATE ON gate_a3_authority_current
  FOR EACH STATEMENT EXECUTE FUNCTION gate_a3_authority_exclusive_statement_lock();
CREATE TRIGGER gate_a3_authority_revocations_exclusive_lock
  BEFORE INSERT ON gate_a3_authority_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION gate_a3_authority_exclusive_statement_lock();

CREATE OR REPLACE FUNCTION validate_gate_a3_authority_envelope_chain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_authority_digest text;
  current_internal_admission_digest text;
  current_state text;
BEGIN
  IF EXISTS (SELECT 1 FROM gate_a3_authority_envelopes existing
    WHERE existing.tenant_id=NEW.tenant_id AND existing.authority_digest=NEW.authority_digest) THEN
    RETURN NEW;
  END IF;

  SELECT stage.authority_digest,stage.state,envelope.internal_admission_digest
    INTO current_authority_digest,current_state,current_internal_admission_digest
    FROM gate_a3_authority_current current
    JOIN gate_a3_authority_stages stage
      ON stage.tenant_id=current.tenant_id AND stage.id=current.stage_id
    JOIN gate_a3_authority_envelopes envelope
      ON envelope.tenant_id=stage.tenant_id AND envelope.authority_digest=stage.authority_digest
    WHERE current.tenant_id=NEW.tenant_id
      AND current.capability_id=NEW.capability_id;

  IF current_authority_digest IS NULL THEN
    IF NEW.renewal_of_internal_admission_digest IS NOT NULL THEN
      RAISE EXCEPTION 'Gate A.3 fresh authority cannot be a detached renewal';
    END IF;
    RETURN NEW;
  END IF;

  IF current_authority_digest=NEW.authority_digest THEN
    RETURN NEW;
  END IF;

  IF current_state<>'internal'
    OR NEW.renewal_of_internal_admission_digest IS DISTINCT FROM current_internal_admission_digest THEN
    RAISE EXCEPTION 'Gate A.3 authority envelope does not renew the current internal admission';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_a3_authority_envelope_chain
  BEFORE INSERT ON gate_a3_authority_envelopes
  FOR EACH ROW EXECUTE FUNCTION validate_gate_a3_authority_envelope_chain();

CREATE OR REPLACE FUNCTION validate_gate_a3_initial_current_not_renewal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_renewal text;
BEGIN
  IF EXISTS (SELECT 1 FROM gate_a3_authority_current current
    WHERE current.tenant_id=NEW.tenant_id AND current.capability_id=NEW.capability_id) THEN
    RETURN NEW;
  END IF;
  SELECT envelope.renewal_of_internal_admission_digest INTO selected_renewal
    FROM gate_a3_authority_stages stage
    JOIN gate_a3_authority_envelopes envelope
      ON envelope.tenant_id=stage.tenant_id AND envelope.authority_digest=stage.authority_digest
    WHERE stage.tenant_id=NEW.tenant_id AND stage.id=NEW.stage_id;
  IF selected_renewal IS NOT NULL THEN
    RAISE EXCEPTION 'Gate A.3 initial current authority cannot be a detached renewal';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_a3_initial_current_not_renewal
  BEFORE INSERT ON gate_a3_authority_current
  FOR EACH ROW EXECUTE FUNCTION validate_gate_a3_initial_current_not_renewal();

ALTER TABLE gate_a3_connector_invocations
  ADD COLUMN retry_scheduled boolean NOT NULL DEFAULT false,
  ADD COLUMN retry_not_before timestamptz,
  ADD CONSTRAINT gate_a3_connector_invocations_retry_check CHECK (
    (retry_scheduled
      AND status='failed'
      AND error_class IN ('CONNECTOR_RATE_LIMITED','CONNECTOR_ROUTE_UNAVAILABLE','CONNECTOR_TIMEOUT')
      AND retry_not_before IS NOT NULL
      AND retry_not_before<deadline)
    OR (NOT retry_scheduled AND retry_not_before IS NULL)
  );

CREATE INDEX gate_a3_connector_invocations_retry_idx
  ON gate_a3_connector_invocations(tenant_id,business_task_id,retry_not_before)
  WHERE retry_scheduled;
