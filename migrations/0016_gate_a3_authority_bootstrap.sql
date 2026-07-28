-- A fresh disposable Control Plane database may start from a canonical signed
-- admission that renews an earlier external admission. Preserve the default
-- detached-renewal rejection and require an explicit, immutable bootstrap
-- proof bound to the exact authority and both admission digests.

CREATE TABLE gate_a3_authority_bootstrap_admissions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  capability_id text NOT NULL CHECK (capability_id='production.work-order-status.v1'),
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  internal_admission_digest text NOT NULL CHECK (internal_admission_digest ~ '^[a-f0-9]{64}$'),
  renewal_of_internal_admission_digest text NOT NULL
    CHECK (renewal_of_internal_admission_digest ~ '^[a-f0-9]{64}$'),
  proof_kind text NOT NULL CHECK (proof_kind='canonical-signed-renewal-bootstrap/1'),
  validation_run_id text NOT NULL CHECK (validation_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  admitted_by text NOT NULL CHECK (admitted_by='geneway-gate-a3-release-helper'),
  external_signature_verified boolean NOT NULL CHECK (external_signature_verified),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,capability_id,authority_digest),
  UNIQUE (tenant_id,internal_admission_digest),
  FOREIGN KEY (tenant_id,authority_digest)
    REFERENCES gate_a3_authority_envelopes(tenant_id,authority_digest)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE OR REPLACE FUNCTION reject_gate_a3_authority_bootstrap_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Gate A.3 authority bootstrap admission is append-only';
END $$;

CREATE TRIGGER gate_a3_authority_bootstrap_append_only
  BEFORE UPDATE OR DELETE ON gate_a3_authority_bootstrap_admissions
  FOR EACH ROW EXECUTE FUNCTION reject_gate_a3_authority_bootstrap_mutation();

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
    IF NEW.renewal_of_internal_admission_digest IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM gate_a3_authority_bootstrap_admissions proof
        WHERE proof.tenant_id=NEW.tenant_id
          AND proof.capability_id=NEW.capability_id
          AND proof.authority_digest=NEW.authority_digest
          AND proof.internal_admission_digest=NEW.internal_admission_digest
          AND proof.renewal_of_internal_admission_digest=NEW.renewal_of_internal_admission_digest
          AND proof.proof_kind='canonical-signed-renewal-bootstrap/1'
          AND proof.external_signature_verified
      ) THEN
      RAISE EXCEPTION 'Gate A.3 fresh authority cannot be a detached renewal';
    END IF;
    RETURN NEW;
  END IF;

  IF current_authority_digest=NEW.authority_digest THEN RETURN NEW; END IF;
  IF current_state<>'internal'
    OR NEW.renewal_of_internal_admission_digest IS DISTINCT FROM current_internal_admission_digest THEN
    RAISE EXCEPTION 'Gate A.3 authority envelope does not renew the current internal admission';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_gate_a3_initial_current_not_renewal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_authority_digest text;
  selected_internal_admission_digest text;
  selected_renewal text;
BEGIN
  IF EXISTS (SELECT 1 FROM gate_a3_authority_current current
    WHERE current.tenant_id=NEW.tenant_id AND current.capability_id=NEW.capability_id) THEN
    RETURN NEW;
  END IF;
  SELECT envelope.authority_digest,envelope.internal_admission_digest,
      envelope.renewal_of_internal_admission_digest
    INTO selected_authority_digest,selected_internal_admission_digest,selected_renewal
    FROM gate_a3_authority_stages stage
    JOIN gate_a3_authority_envelopes envelope
      ON envelope.tenant_id=stage.tenant_id AND envelope.authority_digest=stage.authority_digest
    WHERE stage.tenant_id=NEW.tenant_id AND stage.id=NEW.stage_id;
  IF selected_renewal IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM gate_a3_authority_bootstrap_admissions proof
      WHERE proof.tenant_id=NEW.tenant_id
        AND proof.capability_id=NEW.capability_id
        AND proof.authority_digest=selected_authority_digest
        AND proof.internal_admission_digest=selected_internal_admission_digest
        AND proof.renewal_of_internal_admission_digest=selected_renewal
        AND proof.proof_kind='canonical-signed-renewal-bootstrap/1'
        AND proof.external_signature_verified
    ) THEN
    RAISE EXCEPTION 'Gate A.3 initial current authority cannot be a detached renewal';
  END IF;
  RETURN NEW;
END $$;
