-- Gate A A.2: additive three-route authority. A.1 `/1` rows remain immutable;
-- the active pointer may only roll forward to a fully reviewed higher version.

ALTER TABLE workflow_versions
  DROP CONSTRAINT IF EXISTS workflow_versions_gate_a_variant_check;
ALTER TABLE workflow_versions
  ADD CONSTRAINT workflow_versions_gate_a_variant_check CHECK (
    (record_variant IS NULL AND template_id IS NULL AND registry_digest IS NULL)
    OR
    (record_variant='workflow-read-model.live/1'
      AND template_id IN (
        'workflow-template.solution-live/1',
        'workflow-template.solution-live/2',
        'workflow-template.work-order-status/1'
      )
      AND registry_digest ~ '^[a-f0-9]{64}$'
      AND canonical_json->>'schemaVersion'='workflow-version.template-v1')
  );

DROP TRIGGER IF EXISTS prompt_policy_versions_immutable ON prompt_policy_versions;
CREATE TRIGGER prompt_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON prompt_policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE OR REPLACE FUNCTION validate_capability_release_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_state text;
  previous_sequence bigint;
  previous_capability_version_id text;
  previous_prompt_policy_version_id text;
BEGIN
  IF NEW.sequence=1 THEN
    IF NEW.state<>'draft' OR NEW.previous_release_id IS NOT NULL THEN
      RAISE EXCEPTION 'first capability release must be draft with no predecessor';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.previous_release_id IS NULL THEN
    RAISE EXCEPTION 'capability release transition requires previous release';
  END IF;
  SELECT state,sequence,capability_version_id,prompt_policy_version_id
    INTO previous_state,previous_sequence,previous_capability_version_id,previous_prompt_policy_version_id
    FROM capability_release_records
    WHERE tenant_id=NEW.tenant_id AND id=NEW.previous_release_id;
  IF previous_state IS NULL
    OR previous_capability_version_id<>NEW.capability_version_id
    OR previous_prompt_policy_version_id<>NEW.prompt_policy_version_id
    OR previous_sequence+1<>NEW.sequence
    OR NOT ((previous_state='draft' AND NEW.state='shadow')
      OR (previous_state='shadow' AND NEW.state='internal')) THEN
    RAISE EXCEPTION 'invalid capability release transition';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE capability_release_activation_records (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  schema_version text NOT NULL CHECK (schema_version='capability-release-activation/1'),
  capability_id text NOT NULL,
  previous_active_release_id text NOT NULL,
  previous_pointer_version bigint NOT NULL CHECK (previous_pointer_version>0),
  target_internal_release_id text NOT NULL,
  target_pointer_version bigint NOT NULL CHECK (target_pointer_version=previous_pointer_version+1),
  actor text NOT NULL,
  gate_evidence jsonb NOT NULL CHECK (jsonb_typeof(gate_evidence)='object'),
  gate_evidence_digest text NOT NULL CHECK (gate_evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,capability_id,previous_pointer_version),
  UNIQUE (tenant_id,capability_id,target_pointer_version),
  UNIQUE (tenant_id,target_internal_release_id),
  FOREIGN KEY (tenant_id,previous_active_release_id)
    REFERENCES capability_release_records(tenant_id,id),
  FOREIGN KEY (tenant_id,target_internal_release_id)
    REFERENCES capability_release_records(tenant_id,id)
);

ALTER TABLE capability_active_releases
  ADD COLUMN activation_record_id text,
  ADD CONSTRAINT capability_active_releases_activation_record_fk
    FOREIGN KEY (tenant_id,activation_record_id)
    REFERENCES capability_release_activation_records(tenant_id,id);

CREATE OR REPLACE FUNCTION validate_capability_release_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active_release_id text;
  active_pointer_version bigint;
  previous_state text;
  previous_capability_id text;
  previous_capability_version integer;
  next_state text;
  next_sequence bigint;
  next_capability_id text;
  next_capability_version integer;
  draft_release_id text;
BEGIN
  SELECT release_id,pointer_version INTO active_release_id,active_pointer_version
    FROM capability_active_releases
    WHERE tenant_id=NEW.tenant_id AND capability_id=NEW.capability_id
    FOR UPDATE;
  SELECT previous.state,capability.capability_id,capability.version
    INTO previous_state,previous_capability_id,previous_capability_version
    FROM capability_release_records previous
    JOIN capability_versions capability
      ON capability.tenant_id=previous.tenant_id AND capability.id=previous.capability_version_id
    WHERE previous.tenant_id=NEW.tenant_id AND previous.id=NEW.previous_active_release_id;
  SELECT selected.state,selected.sequence,capability.capability_id,capability.version,draft.id
    INTO next_state,next_sequence,next_capability_id,next_capability_version,draft_release_id
    FROM capability_release_records selected
    JOIN capability_versions capability
      ON capability.tenant_id=selected.tenant_id AND capability.id=selected.capability_version_id
    JOIN capability_release_records shadow
      ON shadow.tenant_id=selected.tenant_id AND shadow.id=selected.previous_release_id
      AND shadow.state='shadow' AND shadow.sequence=2
      AND shadow.capability_version_id=selected.capability_version_id
      AND shadow.prompt_policy_version_id=selected.prompt_policy_version_id
    JOIN capability_release_records draft
      ON draft.tenant_id=shadow.tenant_id AND draft.id=shadow.previous_release_id
      AND draft.state='draft' AND draft.sequence=1 AND draft.previous_release_id IS NULL
      AND draft.capability_version_id=selected.capability_version_id
      AND draft.prompt_policy_version_id=selected.prompt_policy_version_id
    WHERE selected.tenant_id=NEW.tenant_id AND selected.id=NEW.target_internal_release_id;
  IF active_release_id IS DISTINCT FROM NEW.previous_active_release_id
    OR active_pointer_version IS DISTINCT FROM NEW.previous_pointer_version
    OR NEW.target_pointer_version<>NEW.previous_pointer_version+1
    OR previous_state IS DISTINCT FROM 'internal'
    OR previous_capability_id IS DISTINCT FROM NEW.capability_id
    OR next_state IS DISTINCT FROM 'internal'
    OR next_sequence IS DISTINCT FROM 3
    OR draft_release_id IS NULL
    OR next_capability_id IS DISTINCT FROM NEW.capability_id
    OR next_capability_version<=previous_capability_version THEN
    RAISE EXCEPTION 'invalid higher-version capability activation authority';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER capability_release_activation_records_authority_guard
  BEFORE INSERT ON capability_release_activation_records
  FOR EACH ROW EXECUTE FUNCTION validate_capability_release_activation();
CREATE TRIGGER capability_release_activation_records_immutable
  BEFORE UPDATE OR DELETE ON capability_release_activation_records
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE OR REPLACE FUNCTION require_committed_capability_release_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM capability_active_releases active
    WHERE active.tenant_id=NEW.tenant_id
      AND active.capability_id=NEW.capability_id
      AND active.release_id=NEW.target_internal_release_id
      AND active.pointer_version=NEW.target_pointer_version
      AND active.activation_record_id=NEW.id
  ) THEN
    RAISE EXCEPTION 'capability release activation record must commit with its exact active pointer';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER capability_release_activation_records_committed_pointer
  AFTER INSERT ON capability_release_activation_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_committed_capability_release_activation();

CREATE OR REPLACE FUNCTION validate_capability_active_pointer_cas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  selected_previous_release_id text;
  selected_state text;
  selected_sequence bigint;
  selected_capability_id text;
  selected_capability_version_id text;
  selected_capability_version integer;
  previous_state text;
  previous_capability_version_id text;
  previous_capability_version integer;
  activation_record_id text;
BEGIN
  SELECT release.previous_release_id,release.state,release.sequence,
    release.capability_version_id,capability.capability_id,capability.version
    INTO selected_previous_release_id,selected_state,selected_sequence,
      selected_capability_version_id,selected_capability_id,selected_capability_version
    FROM capability_release_records release
    JOIN capability_versions capability
      ON capability.tenant_id=release.tenant_id AND capability.id=release.capability_version_id
    WHERE release.tenant_id=NEW.tenant_id AND release.id=NEW.release_id;
  IF selected_state IS NULL OR selected_capability_id<>NEW.capability_id THEN
    RAISE EXCEPTION 'capability active release pointer target is invalid';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.pointer_version<>1 OR selected_state<>'draft' OR selected_sequence<>1
      OR selected_previous_release_id IS NOT NULL OR NEW.activation_record_id IS NOT NULL THEN
      RAISE EXCEPTION 'initial capability active release pointer must select the first draft';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.pointer_version<>OLD.pointer_version+1
    OR NEW.capability_id<>OLD.capability_id OR NEW.tenant_id<>OLD.tenant_id THEN
    RAISE EXCEPTION 'capability active release pointer CAS failed';
  END IF;

  -- Existing same-version draft -> shadow -> internal transition.
  IF selected_previous_release_id=OLD.release_id THEN
    IF NEW.activation_record_id IS DISTINCT FROM OLD.activation_record_id THEN
      RAISE EXCEPTION 'same-version active release transition cannot replace activation authority';
    END IF;
    RETURN NEW;
  END IF;

  -- Additive cross-version rollover: an immutable activation record authorizes
  -- exactly one old internal pointer -> fully formed higher-version internal CAS.
  SELECT prior.state,prior.capability_version_id,prior_capability.version
    INTO previous_state,previous_capability_version_id,previous_capability_version
    FROM capability_release_records prior
    JOIN capability_versions prior_capability
      ON prior_capability.tenant_id=prior.tenant_id AND prior_capability.id=prior.capability_version_id
    WHERE prior.tenant_id=OLD.tenant_id AND prior.id=OLD.release_id;
  SELECT activation.id INTO activation_record_id
    FROM capability_release_activation_records activation
    WHERE activation.tenant_id=NEW.tenant_id
      AND activation.id=NEW.activation_record_id
      AND activation.capability_id=NEW.capability_id
      AND activation.previous_active_release_id=OLD.release_id
      AND activation.previous_pointer_version=OLD.pointer_version
      AND activation.target_internal_release_id=NEW.release_id
      AND activation.target_pointer_version=NEW.pointer_version;
  IF previous_state IS DISTINCT FROM 'internal'
    OR activation_record_id IS NULL
    OR NEW.activation_record_id IS NOT DISTINCT FROM OLD.activation_record_id
    OR selected_capability_version<=previous_capability_version
    OR EXISTS (
      SELECT 1 FROM business_tasks task
      WHERE task.tenant_id=OLD.tenant_id
        AND task.capability_version_id=previous_capability_version_id
        AND task.status NOT IN ('completed','failed','canceled')
    ) OR EXISTS (
      SELECT 1 FROM gate_a_model_invocations invocation
      WHERE invocation.tenant_id=OLD.tenant_id
        AND invocation.capability_version_id=previous_capability_version_id
        AND invocation.status NOT IN ('completed','failed','canceled')
    ) THEN
    RAISE EXCEPTION 'capability higher-version active rollover is invalid or not quiescent';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS capability_active_releases_cas ON capability_active_releases;
CREATE TRIGGER capability_active_releases_cas
  BEFORE INSERT OR UPDATE ON capability_active_releases
  FOR EACH ROW EXECUTE FUNCTION validate_capability_active_pointer_cas();
CREATE TRIGGER capability_active_releases_no_delete
  BEFORE DELETE ON capability_active_releases
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE OR REPLACE FUNCTION guard_live_business_task_active_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_capability_id text;
  active_capability_version_id text;
  active_state text;
BEGIN
  IF NEW.record_variant IS DISTINCT FROM 'business-task.live/1' THEN
    RETURN NEW;
  END IF;
  SELECT capability.capability_id INTO task_capability_id
    FROM capability_versions capability
    WHERE capability.tenant_id=NEW.tenant_id AND capability.id=NEW.capability_version_id;
  SELECT release.capability_version_id,release.state
    INTO active_capability_version_id,active_state
    FROM capability_active_releases active
    JOIN capability_release_records release
      ON release.tenant_id=active.tenant_id AND release.id=active.release_id
    WHERE active.tenant_id=NEW.tenant_id AND active.capability_id=task_capability_id
    FOR SHARE OF active;
  IF active_state IS DISTINCT FROM 'internal'
    OR active_capability_version_id IS DISTINCT FROM NEW.capability_version_id THEN
    RAISE EXCEPTION 'live business task capability version is not the locked active internal release';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER business_tasks_live_active_release_guard
  BEFORE INSERT ON business_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_live_business_task_active_release();
