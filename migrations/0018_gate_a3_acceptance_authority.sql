-- Corrected Gate A.3 authority is durable source material, not a caller-owned
-- "signature verified" boolean. The Control Plane re-verifies these exact
-- append-only bytes against the frozen actor registry whenever it consumes the
-- shadow acceptance overlay or a promotion aggregate.

CREATE TABLE gate_a3_acceptance_authority_bundles (
  tenant_id text NOT NULL REFERENCES tenants(id),
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[a-f0-9]{64}$'),
  strict_preflight_digest text NOT NULL CHECK (strict_preflight_digest ~ '^[a-f0-9]{64}$'),
  controller_record_digest text NOT NULL CHECK (controller_record_digest ~ '^[a-f0-9]{64}$'),
  actor_registry_digest text NOT NULL CHECK (actor_registry_digest ~ '^[a-f0-9]{64}$'),
  acceptance_admission_digest text NOT NULL CHECK (acceptance_admission_digest ~ '^[a-f0-9]{64}$'),
  prelaunch_receipt_digest text NOT NULL CHECK (prelaunch_receipt_digest ~ '^[a-f0-9]{64}$'),
  provider_credential_version_id text NOT NULL,
  connector_credential_version_id text NOT NULL,
  actor_registry jsonb NOT NULL CHECK (jsonb_typeof(actor_registry)='object'),
  acceptance_admission jsonb NOT NULL CHECK (jsonb_typeof(acceptance_admission)='object'),
  prelaunch_receipt jsonb NOT NULL CHECK (jsonb_typeof(prelaunch_receipt)='object'),
  authority_envelope jsonb NOT NULL CHECK (jsonb_typeof(authority_envelope)='object'),
  bundle jsonb NOT NULL CHECK (jsonb_typeof(bundle)='object'),
  bundle_digest text NOT NULL CHECK (bundle_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  declared_maximum_run_duration_ms integer NOT NULL CHECK (declared_maximum_run_duration_ms > 0),
  max_invocation_token_ttl_ms integer NOT NULL CHECK (max_invocation_token_ttl_ms > 0),
  shutdown_grace_ms integer NOT NULL CHECK (shutdown_grace_ms >= 30000),
  release_state text NOT NULL CHECK (release_state='shadow'),
  public_customer_state text NOT NULL CHECK (public_customer_state='NOT_OPEN'),
  renewal_of text CHECK (renewal_of IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,authority_digest),
  UNIQUE (tenant_id,run_id),
  UNIQUE (tenant_id,acceptance_admission_digest),
  UNIQUE (tenant_id,prelaunch_receipt_digest),
  FOREIGN KEY (tenant_id,authority_digest)
    REFERENCES gate_a3_authority_envelopes(tenant_id,authority_digest)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (expires_at > issued_at),
  CHECK (expires_at - issued_at <= interval '8 hours'),
  CHECK (expires_at >= issued_at
    + (declared_maximum_run_duration_ms + max_invocation_token_ttl_ms + shutdown_grace_ms)
      * interval '1 millisecond')
);

CREATE TABLE gate_a3_acceptance_actor_receipts (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('reviewer','verifier','controller','signer')),
  actor_id text NOT NULL,
  session_id text NOT NULL,
  key_id text NOT NULL,
  nonce text NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  raw_receipt jsonb NOT NULL CHECK (jsonb_typeof(raw_receipt)='object'),
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  issued_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,run_id,role),
  UNIQUE (tenant_id,run_id,actor_id),
  UNIQUE (tenant_id,run_id,session_id),
  UNIQUE (tenant_id,run_id,key_id),
  UNIQUE (tenant_id,nonce),
  UNIQUE (tenant_id,receipt_digest),
  FOREIGN KEY (tenant_id,run_id)
    REFERENCES gate_a3_acceptance_authority_bundles(tenant_id,run_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE gate_a3_acceptance_aggregates (
  tenant_id text NOT NULL,
  capability_id text NOT NULL CHECK (capability_id='production.work-order-status.v1'),
  run_id text NOT NULL,
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  source_manifest_digest text NOT NULL CHECK (source_manifest_digest ~ '^[a-f0-9]{64}$'),
  acceptance_admission_digest text NOT NULL CHECK (acceptance_admission_digest ~ '^[a-f0-9]{64}$'),
  provider_credential_version_id text NOT NULL,
  connector_credential_version_id text NOT NULL,
  aggregate_digest text NOT NULL CHECK (aggregate_digest ~ '^[a-f0-9]{64}$'),
  aggregate jsonb NOT NULL CHECK (jsonb_typeof(aggregate)='object'),
  verifier_actor_id text NOT NULL,
  verifier_session_id text NOT NULL,
  verifier_key_id text NOT NULL,
  verifier_nonce text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,capability_id,run_id),
  UNIQUE (tenant_id,aggregate_digest),
  UNIQUE (tenant_id,verifier_nonce),
  FOREIGN KEY (tenant_id,run_id)
    REFERENCES gate_a3_acceptance_authority_bundles(tenant_id,run_id),
  CHECK (expires_at > issued_at)
);

CREATE TABLE gate_a3_acceptance_promotions (
  tenant_id text NOT NULL,
  capability_id text NOT NULL CHECK (capability_id='production.work-order-status.v1'),
  run_id text NOT NULL,
  aggregate_digest text NOT NULL CHECK (aggregate_digest ~ '^[a-f0-9]{64}$'),
  previous_release_id text NOT NULL,
  promoted_release_id text NOT NULL,
  previous_pointer_version bigint NOT NULL CHECK (previous_pointer_version > 0),
  promoted_pointer_version bigint NOT NULL CHECK (promoted_pointer_version=previous_pointer_version+1),
  promoted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,capability_id,run_id),
  UNIQUE (tenant_id,capability_id,promoted_release_id),
  FOREIGN KEY (tenant_id,capability_id,run_id)
    REFERENCES gate_a3_acceptance_aggregates(tenant_id,capability_id,run_id)
);

CREATE OR REPLACE FUNCTION reject_gate_a3_acceptance_authority_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Gate A.3 acceptance authority is append-only';
END $$;

CREATE TRIGGER gate_a3_acceptance_bundle_append_only
  BEFORE UPDATE OR DELETE ON gate_a3_acceptance_authority_bundles
  FOR EACH ROW EXECUTE FUNCTION reject_gate_a3_acceptance_authority_mutation();
CREATE TRIGGER gate_a3_acceptance_actor_receipt_append_only
  BEFORE UPDATE OR DELETE ON gate_a3_acceptance_actor_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_gate_a3_acceptance_authority_mutation();
CREATE TRIGGER gate_a3_acceptance_aggregate_append_only
  BEFORE UPDATE OR DELETE ON gate_a3_acceptance_aggregates
  FOR EACH ROW EXECUTE FUNCTION reject_gate_a3_acceptance_authority_mutation();
CREATE TRIGGER gate_a3_acceptance_promotion_append_only
  BEFORE UPDATE OR DELETE ON gate_a3_acceptance_promotions
  FOR EACH ROW EXECUTE FUNCTION reject_gate_a3_acceptance_authority_mutation();
