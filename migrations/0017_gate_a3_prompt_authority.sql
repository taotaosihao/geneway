-- Gate A A.3: bind every model invocation to the exact immutable PromptPolicy
-- UTF-8 bytes used by Model Gateway. The wire /2 rollout is deliberately a
-- quiescent migration: an already-issued nonterminal wire /1 invocation cannot
-- be re-signed, so it must be drained before the schema advances.

LOCK TABLE gate_a3_model_invocations IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gate_a3_model_invocations
    WHERE status IN ('authorized','running')
  ) THEN
    RAISE EXCEPTION 'Gate A.3 nonterminal model invocations must be drained before PromptPolicy wire /2 migration';
  END IF;
END $$;

ALTER TABLE gate_a3_model_invocations
  ADD COLUMN prompt_policy_resolved_bytes_sha256 text;

-- Migration 0015 treats every non-lifecycle column as immutable identity. Hold
-- the exclusive lock and disable only that named trigger for this one-time
-- historical identity completion; transactional DDL restores it on rollback.
ALTER TABLE gate_a3_model_invocations
  DISABLE TRIGGER gate_a3_model_invocations_lifecycle;

UPDATE gate_a3_model_invocations invocation
SET prompt_policy_resolved_bytes_sha256 = encode(
  digest(convert_to(policy.policy->>'system','UTF8'),'sha256'),
  'hex'
)
FROM prompt_policy_versions policy
WHERE policy.tenant_id=invocation.tenant_id
  AND policy.id=invocation.policy_version
  AND jsonb_typeof(policy.policy->'system')='string'
  AND length(policy.policy->>'system') BETWEEN 1 AND 16384;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gate_a3_model_invocations
    WHERE prompt_policy_resolved_bytes_sha256 IS NULL
  ) THEN
    RAISE EXCEPTION 'Gate A.3 model invocation has no resolvable immutable PromptPolicy';
  END IF;
END $$;

ALTER TABLE gate_a3_model_invocations
  ENABLE TRIGGER gate_a3_model_invocations_lifecycle;

ALTER TABLE gate_a3_model_invocations
  ALTER COLUMN prompt_policy_resolved_bytes_sha256 SET NOT NULL,
  ADD CONSTRAINT gate_a3_model_invocations_prompt_digest_shape
    CHECK (prompt_policy_resolved_bytes_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT gate_a3_model_invocations_prompt_policy_fk
    FOREIGN KEY (tenant_id,policy_version)
    REFERENCES prompt_policy_versions(tenant_id,id);
