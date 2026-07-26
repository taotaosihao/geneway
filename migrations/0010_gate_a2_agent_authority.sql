-- Gate A A.2: bind every live ModelInvocation to the exact immutable
-- AgentVersion while preserving historical A.1 rows with a NULL binding.

ALTER TABLE gate_a_model_invocations
  ADD COLUMN agent_version_id text,
  ADD CONSTRAINT gate_a_model_invocations_agent_version_check CHECK (
    (capability_version_id='cap_solution_analysis_v1_live_1' AND agent_version_id IS NULL)
    OR
    (capability_version_id='cap_solution_analysis_v1_live_2' AND agent_version_id IS NOT NULL AND (
      (step_id='requirement_extract' AND agent_version_id='agent.solution.requirement/live-2')
      OR (step_id='contradiction_check' AND agent_version_id='agent.solution.contradiction/live-2')
      OR (step_id='solution_design' AND agent_version_id='agent.solution.architect/live-2')
    ))
  );

ALTER TABLE business_tasks
  ADD CONSTRAINT business_tasks_capability_authority_tuple_uq
    UNIQUE (tenant_id,id,capability_version_id);

ALTER TABLE gate_a_model_invocations
  ADD CONSTRAINT gate_a_model_invocations_task_capability_fk
    FOREIGN KEY (tenant_id,business_task_id,capability_version_id)
    REFERENCES business_tasks(tenant_id,id,capability_version_id);

CREATE INDEX gate_a_model_invocations_agent_version_idx
  ON gate_a_model_invocations(tenant_id,agent_version_id,created_at)
  WHERE agent_version_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_gate_a_invocation_candidate_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence_candidate_projection IS DISTINCT FROM OLD.evidence_candidate_projection THEN
    RAISE EXCEPTION 'Gate A invocation-approved Evidence candidate projection is immutable';
  END IF;
  IF NEW.canonical_selection_projection IS DISTINCT FROM OLD.canonical_selection_projection
    OR NEW.canonical_selection_projection_digest IS DISTINCT FROM OLD.canonical_selection_projection_digest
    OR NEW.selected_model_input_sha256 IS DISTINCT FROM OLD.selected_model_input_sha256 THEN
    RAISE EXCEPTION 'Gate A invocation canonical selection projection is immutable';
  END IF;
  IF NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id THEN
    RAISE EXCEPTION 'Gate A invocation AgentVersion authority is immutable';
  END IF;
  RETURN NEW;
END $$;
