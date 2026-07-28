-- Gate A A.3 current-authority envelope. Authority documents and stages are
-- append-only; the one mutable row is a CAS current pointer. Revocation is an
-- append-only fact and is checked on every runtime authority decision.

CREATE TABLE gate_a3_authority_envelopes (
  tenant_id text NOT NULL REFERENCES tenants(id),
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  schema_version text NOT NULL CHECK (schema_version='gate-a3-authority-envelope/1'),
  capability_id text NOT NULL CHECK (capability_id='production.work-order-status.v1'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object'),
  approved_preflight_digest text NOT NULL CHECK (approved_preflight_digest ~ '^[a-f0-9]{64}$'),
  controller_admission_digest text NOT NULL CHECK (controller_admission_digest ~ '^[a-f0-9]{64}$'),
  internal_admission_digest text NOT NULL CHECK (internal_admission_digest ~ '^[a-f0-9]{64}$'),
  renewal_of_internal_admission_digest text CHECK (renewal_of_internal_admission_digest IS NULL
    OR renewal_of_internal_admission_digest ~ '^[a-f0-9]{64}$'),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>effective_at),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,authority_digest),
  UNIQUE (tenant_id,internal_admission_digest)
);

CREATE TABLE gate_a3_authority_stages (
  tenant_id text NOT NULL,
  id text NOT NULL,
  authority_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','shadow','internal')),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  previous_stage_id text,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,authority_digest,state),
  UNIQUE (tenant_id,authority_digest,sequence),
  FOREIGN KEY (tenant_id,authority_digest) REFERENCES gate_a3_authority_envelopes(tenant_id,authority_digest),
  FOREIGN KEY (tenant_id,previous_stage_id) REFERENCES gate_a3_authority_stages(tenant_id,id)
);

CREATE TABLE gate_a3_authority_current (
  tenant_id text NOT NULL,
  capability_id text NOT NULL CHECK (capability_id='production.work-order-status.v1'),
  stage_id text NOT NULL,
  pointer_version bigint NOT NULL CHECK (pointer_version>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,capability_id),
  FOREIGN KEY (tenant_id,stage_id) REFERENCES gate_a3_authority_stages(tenant_id,id)
);

CREATE TABLE gate_a3_authority_revocations (
  tenant_id text NOT NULL,
  id text NOT NULL,
  authority_digest text NOT NULL,
  actor text NOT NULL,
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[a-f0-9]{64}$'),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,authority_digest),
  FOREIGN KEY (tenant_id,authority_digest) REFERENCES gate_a3_authority_envelopes(tenant_id,authority_digest)
);

CREATE OR REPLACE FUNCTION validate_gate_a3_authority_stage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_authority_digest text;
  previous_state text;
  previous_sequence integer;
BEGIN
  IF NEW.sequence=1 THEN
    IF NEW.state<>'draft' OR NEW.previous_stage_id IS NOT NULL THEN
      RAISE EXCEPTION 'Gate A.3 authority starts at draft';
    END IF;
    RETURN NEW;
  END IF;
  SELECT authority_digest,state,sequence INTO previous_authority_digest,previous_state,previous_sequence
    FROM gate_a3_authority_stages WHERE tenant_id=NEW.tenant_id AND id=NEW.previous_stage_id;
  IF previous_authority_digest IS DISTINCT FROM NEW.authority_digest
    OR previous_sequence IS DISTINCT FROM NEW.sequence-1
    OR NOT ((previous_state='draft' AND NEW.state='shadow')
      OR (previous_state='shadow' AND NEW.state='internal')) THEN
    RAISE EXCEPTION 'invalid Gate A.3 authority stage transition';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_a3_authority_stage_transition
  BEFORE INSERT ON gate_a3_authority_stages
  FOR EACH ROW EXECUTE FUNCTION validate_gate_a3_authority_stage();

CREATE OR REPLACE FUNCTION validate_gate_a3_authority_current_cas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_authority_digest text;
  selected_state text;
  selected_sequence integer;
  old_authority_digest text;
  old_state text;
  old_internal_admission_digest text;
  renewal_of_internal_admission_digest text;
BEGIN
  SELECT authority_digest,state,sequence INTO selected_authority_digest,selected_state,selected_sequence
    FROM gate_a3_authority_stages WHERE tenant_id=NEW.tenant_id AND id=NEW.stage_id;
  IF selected_state IS NULL THEN RAISE EXCEPTION 'Gate A.3 current authority stage is missing'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.pointer_version<>1 OR selected_state<>'draft' OR selected_sequence<>1 THEN
      RAISE EXCEPTION 'Gate A.3 initial current authority must be draft';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.pointer_version<>OLD.pointer_version+1 OR NEW.tenant_id<>OLD.tenant_id
    OR NEW.capability_id<>OLD.capability_id THEN
    RAISE EXCEPTION 'Gate A.3 current authority CAS failed';
  END IF;
  SELECT authority_digest,state INTO old_authority_digest,old_state
    FROM gate_a3_authority_stages WHERE tenant_id=OLD.tenant_id AND id=OLD.stage_id;
  IF selected_authority_digest=old_authority_digest THEN
    IF NOT ((old_state='draft' AND selected_state='shadow')
      OR (old_state='shadow' AND selected_state='internal')) THEN
      RAISE EXCEPTION 'Gate A.3 current authority promotion is invalid';
    END IF;
    RETURN NEW;
  END IF;
  SELECT internal_admission_digest INTO old_internal_admission_digest
    FROM gate_a3_authority_envelopes WHERE tenant_id=OLD.tenant_id AND authority_digest=old_authority_digest;
  SELECT envelope.renewal_of_internal_admission_digest INTO renewal_of_internal_admission_digest
    FROM gate_a3_authority_envelopes envelope
    WHERE envelope.tenant_id=NEW.tenant_id AND envelope.authority_digest=selected_authority_digest;
  IF old_state<>'internal' OR selected_state<>'draft' OR selected_sequence<>1
    OR renewal_of_internal_admission_digest IS DISTINCT FROM old_internal_admission_digest THEN
    RAISE EXCEPTION 'Gate A.3 authority renewal does not bind the current internal admission';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_a3_authority_current_cas
  BEFORE INSERT OR UPDATE ON gate_a3_authority_current
  FOR EACH ROW EXECUTE FUNCTION validate_gate_a3_authority_current_cas();

CREATE TRIGGER gate_a3_authority_envelopes_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_authority_envelopes
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER gate_a3_authority_stages_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_authority_stages
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER gate_a3_authority_current_no_delete
  BEFORE DELETE ON gate_a3_authority_current
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER gate_a3_authority_revocations_immutable
  BEFORE UPDATE OR DELETE ON gate_a3_authority_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

ALTER TABLE business_tasks
  ADD COLUMN gate_a3_authority_digest text,
  ADD CONSTRAINT business_tasks_gate_a3_authority_digest_shape CHECK (
    (record_variant='business-task.work-order.live/1' AND gate_a3_authority_digest ~ '^[a-f0-9]{64}$')
    OR (record_variant IS DISTINCT FROM 'business-task.work-order.live/1' AND gate_a3_authority_digest IS NULL)
  ),
  ADD CONSTRAINT business_tasks_gate_a3_authority_digest_fk
    FOREIGN KEY (tenant_id,gate_a3_authority_digest)
    REFERENCES gate_a3_authority_envelopes(tenant_id,authority_digest);
