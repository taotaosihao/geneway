-- Gate A A.3 terminal database authority hardening. Every mutable gateway
-- authorization has a one-way lifecycle, and every publication relation is
-- bound to one task/effect lineage before the task can become completed.

ALTER TABLE gate_a3_connector_query_specs
  ADD CONSTRAINT gate_a3_connector_query_specs_task_hash_uq
    UNIQUE (tenant_id,id,business_task_id,spec_hash);

ALTER TABLE gate_a3_connector_invocations
  ADD CONSTRAINT gate_a3_connector_invocations_task_id_uq
    UNIQUE (tenant_id,id,business_task_id),
  ADD CONSTRAINT gate_a3_connector_invocations_task_effect_uq
    UNIQUE (tenant_id,id,business_task_id,effect_id),
  ADD CONSTRAINT gate_a3_connector_invocations_spec_task_fk
    FOREIGN KEY (tenant_id,connector_query_spec_id,business_task_id,connector_query_spec_hash)
    REFERENCES gate_a3_connector_query_specs(tenant_id,id,business_task_id,spec_hash);

ALTER TABLE gate_a3_connector_token_authorizations
  ADD CONSTRAINT gate_a3_connector_token_authorizations_invocation_task_fk
    FOREIGN KEY (tenant_id,connector_invocation_id,business_task_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id,business_task_id);

ALTER TABLE gate_a3_connector_source_snapshots
  ADD CONSTRAINT gate_a3_connector_source_snapshots_task_effect_invocation_uq
    UNIQUE (tenant_id,id,business_task_id,effect_id,connector_invocation_id),
  ADD CONSTRAINT gate_a3_connector_source_snapshots_invocation_task_effect_fk
    FOREIGN KEY (tenant_id,connector_invocation_id,business_task_id,effect_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id,business_task_id,effect_id),
  ADD CONSTRAINT gate_a3_connector_source_snapshots_spec_task_fk
    FOREIGN KEY (tenant_id,connector_query_spec_id,business_task_id,connector_query_spec_hash)
    REFERENCES gate_a3_connector_query_specs(tenant_id,id,business_task_id,spec_hash);

ALTER TABLE gate_a3_connector_evidence
  ADD CONSTRAINT gate_a3_connector_evidence_snapshot_task_effect_fk
    FOREIGN KEY (tenant_id,connector_source_snapshot_id,business_task_id,effect_id,connector_invocation_id)
    REFERENCES gate_a3_connector_source_snapshots(
      tenant_id,id,business_task_id,effect_id,connector_invocation_id),
  ADD CONSTRAINT gate_a3_connector_evidence_invocation_task_effect_fk
    FOREIGN KEY (tenant_id,connector_invocation_id,business_task_id,effect_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id,business_task_id,effect_id);

ALTER TABLE gate_a3_model_invocations
  ADD CONSTRAINT gate_a3_model_invocations_task_snapshot_uq
    UNIQUE (tenant_id,id,business_task_id,connector_source_snapshot_id),
  ADD CONSTRAINT gate_a3_model_invocations_snapshot_task_fk
    FOREIGN KEY (tenant_id,connector_source_snapshot_id,business_task_id)
    REFERENCES gate_a3_connector_source_snapshots(tenant_id,id,business_task_id);

ALTER TABLE gate_a3_work_order_explanations
  ADD CONSTRAINT gate_a3_work_order_explanations_task_snapshot_uq
    UNIQUE (tenant_id,id,business_task_id,connector_source_snapshot_id),
  ADD CONSTRAINT gate_a3_work_order_explanations_task_snapshot_model_uq
    UNIQUE (tenant_id,id,business_task_id,connector_source_snapshot_id,model_invocation_id),
  ADD CONSTRAINT gate_a3_work_order_explanations_model_task_snapshot_fk
    FOREIGN KEY (tenant_id,model_invocation_id,business_task_id,connector_source_snapshot_id)
    REFERENCES gate_a3_model_invocations(
      tenant_id,id,business_task_id,connector_source_snapshot_id),
  ADD CONSTRAINT gate_a3_work_order_explanations_snapshot_task_fk
    FOREIGN KEY (tenant_id,connector_source_snapshot_id,business_task_id)
    REFERENCES gate_a3_connector_source_snapshots(tenant_id,id,business_task_id);

ALTER TABLE gate_a3_work_order_results
  ADD CONSTRAINT gate_a3_work_order_results_snapshot_task_effect_fk
    FOREIGN KEY (tenant_id,connector_source_snapshot_id,business_task_id,effect_id,connector_invocation_id)
    REFERENCES gate_a3_connector_source_snapshots(
      tenant_id,id,business_task_id,effect_id,connector_invocation_id),
  ADD CONSTRAINT gate_a3_work_order_results_invocation_task_effect_fk
    FOREIGN KEY (tenant_id,connector_invocation_id,business_task_id,effect_id)
    REFERENCES gate_a3_connector_invocations(tenant_id,id,business_task_id,effect_id),
  ADD CONSTRAINT gate_a3_work_order_results_explanation_task_snapshot_fk
    FOREIGN KEY (tenant_id,explanation_id,business_task_id,connector_source_snapshot_id)
    REFERENCES gate_a3_work_order_explanations(
      tenant_id,id,business_task_id,connector_source_snapshot_id);

CREATE OR REPLACE FUNCTION guard_gate_a3_connector_token_authorization()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.invalidated_at IS NOT NULL THEN
      RAISE EXCEPTION 'new Gate A.3 connector token authorization must be unused';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Gate A.3 connector token authorization cannot be deleted';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.jti_digest IS DISTINCT FROM OLD.jti_digest
    OR NEW.connector_invocation_id IS DISTINCT FROM OLD.connector_invocation_id
    OR NEW.business_task_id IS DISTINCT FROM OLD.business_task_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Gate A.3 connector token authorization identity is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'Gate A.3 connector token consumption is one-way';
  END IF;
  IF OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    RAISE EXCEPTION 'Gate A.3 connector token invalidation is one-way';
  END IF;
  IF (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
      AND NEW.invalidated_at IS NOT NULL)
    OR (OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL
      AND NEW.consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Gate A.3 connector token cannot be consumed and invalidated';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gate_a3_connector_token_authorizations_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON gate_a3_connector_token_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_gate_a3_connector_token_authorization();

CREATE OR REPLACE FUNCTION guard_gate_a3_connector_invocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'authorized' OR NEW.error_class IS NOT NULL
      OR NEW.response_ref_matched IS NOT NULL OR NEW.source_revision IS NOT NULL
      OR NEW.response_canonical_hash IS NOT NULL OR NEW.started_at IS NOT NULL
      OR NEW.terminal_at IS NOT NULL OR NEW.retry_scheduled OR NEW.retry_not_before IS NOT NULL THEN
      RAISE EXCEPTION 'new Gate A.3 connector invocation must start authorized';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Gate A.3 connector invocation cannot be deleted';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','error_class','response_ref_matched','source_revision',
      'response_canonical_hash','redacted_audit','started_at','terminal_at',
      'retry_scheduled','retry_not_before'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','error_class','response_ref_matched','source_revision',
      'response_canonical_hash','redacted_audit','started_at','terminal_at',
      'retry_scheduled','retry_not_before']) THEN
    RAISE EXCEPTION 'Gate A.3 connector invocation identity is immutable';
  END IF;
  IF NOT (NEW.redacted_audit @> OLD.redacted_audit) THEN
    RAISE EXCEPTION 'Gate A.3 connector invocation audit may only expand';
  END IF;
  IF OLD.status IN ('completed','failed','canceled') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal Gate A.3 connector invocation is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status=OLD.status THEN
    IF (to_jsonb(NEW)-'redacted_audit') IS DISTINCT FROM (to_jsonb(OLD)-'redacted_audit') THEN
      RAISE EXCEPTION 'nonterminal Gate A.3 connector invocation may only expand its audit';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='authorized' AND NEW.status='running' THEN
    IF OLD.started_at IS NOT NULL OR NEW.started_at IS NULL
      OR NEW.error_class IS DISTINCT FROM OLD.error_class
      OR NEW.response_ref_matched IS DISTINCT FROM OLD.response_ref_matched
      OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
      OR NEW.response_canonical_hash IS DISTINCT FROM OLD.response_canonical_hash
      OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at
      OR NEW.retry_scheduled IS DISTINCT FROM OLD.retry_scheduled
      OR NEW.retry_not_before IS DISTINCT FROM OLD.retry_not_before THEN
      RAISE EXCEPTION 'invalid Gate A.3 connector authorized-to-running transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='running' AND NEW.status='completed' THEN
    IF NEW.terminal_at IS NULL OR NEW.retry_scheduled OR NEW.retry_not_before IS NOT NULL THEN
      RAISE EXCEPTION 'invalid Gate A.3 connector completion transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('authorized','running') AND NEW.status IN ('failed','canceled') THEN
    IF NEW.terminal_at IS NULL THEN
      RAISE EXCEPTION 'terminal Gate A.3 connector transition requires terminal_at';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid Gate A.3 connector invocation status transition';
END $$;

CREATE TRIGGER gate_a3_connector_invocations_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON gate_a3_connector_invocations
  FOR EACH ROW EXECUTE FUNCTION guard_gate_a3_connector_invocation();

CREATE OR REPLACE FUNCTION guard_gate_a3_model_invocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'authorized' OR NEW.consumed_at IS NOT NULL OR NEW.invalidated_at IS NOT NULL
      OR NEW.receipt IS NOT NULL OR NEW.receipt_digest IS NOT NULL OR NEW.error_class IS NOT NULL
      OR NEW.started_at IS NOT NULL OR NEW.terminal_at IS NOT NULL THEN
      RAISE EXCEPTION 'new Gate A.3 model invocation must start authorized';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Gate A.3 model invocation cannot be deleted';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['consumed_at','invalidated_at','status','receipt','receipt_digest',
      'error_class','started_at','terminal_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['consumed_at','invalidated_at','status','receipt','receipt_digest',
      'error_class','started_at','terminal_at']) THEN
    RAISE EXCEPTION 'Gate A.3 model invocation identity is immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'Gate A.3 model invocation consumption is one-way';
  END IF;
  IF OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    RAISE EXCEPTION 'Gate A.3 model invocation invalidation is one-way';
  END IF;
  IF OLD.receipt IS NOT NULL AND (NEW.receipt IS DISTINCT FROM OLD.receipt
      OR NEW.receipt_digest IS DISTINCT FROM OLD.receipt_digest) THEN
    RAISE EXCEPTION 'Gate A.3 model invocation receipt is immutable once written';
  END IF;
  IF (NEW.receipt IS NULL) <> (NEW.receipt_digest IS NULL) THEN
    RAISE EXCEPTION 'Gate A.3 model invocation receipt and digest must be written together';
  END IF;
  IF OLD.status IN ('completed','failed','canceled') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal Gate A.3 model invocation is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status=OLD.status THEN
    IF OLD.receipt IS NOT NULL OR NEW.receipt IS NULL
      OR (to_jsonb(NEW)-ARRAY['receipt','receipt_digest'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt','receipt_digest']) THEN
      IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'nonterminal Gate A.3 model invocation may only record one failure receipt';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='authorized' AND NEW.status='running' THEN
    IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
      OR NEW.invalidated_at IS NOT NULL OR OLD.started_at IS NOT NULL OR NEW.started_at IS NULL
      OR NEW.receipt IS DISTINCT FROM OLD.receipt
      OR NEW.receipt_digest IS DISTINCT FROM OLD.receipt_digest
      OR NEW.error_class IS DISTINCT FROM OLD.error_class
      OR NEW.terminal_at IS DISTINCT FROM OLD.terminal_at THEN
      RAISE EXCEPTION 'invalid Gate A.3 model authorized-to-running transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='running' AND NEW.status='completed' THEN
    IF NEW.terminal_at IS NULL OR NEW.receipt IS NULL OR NEW.receipt_digest IS NULL
      OR NEW.invalidated_at IS NOT NULL OR NEW.error_class IS NOT NULL THEN
      RAISE EXCEPTION 'invalid Gate A.3 model completion transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('authorized','running') AND NEW.status IN ('failed','canceled') THEN
    IF NEW.terminal_at IS NULL
      OR (OLD.status='authorized' AND NEW.consumed_at IS NULL AND NEW.invalidated_at IS NULL)
      OR (OLD.status='running' AND NEW.invalidated_at IS NOT NULL) THEN
      RAISE EXCEPTION 'invalid Gate A.3 model terminal transition';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid Gate A.3 model invocation status transition';
END $$;

CREATE TRIGGER gate_a3_model_invocations_lifecycle
  BEFORE INSERT OR UPDATE OR DELETE ON gate_a3_model_invocations
  FOR EACH ROW EXECUTE FUNCTION guard_gate_a3_model_invocation();

CREATE OR REPLACE FUNCTION guard_gate_a3_terminal_task_result_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.record_variant='business-task.work-order.live/1'
      AND OLD.status IN ('completed','failed','canceled') THEN
      RAISE EXCEPTION 'terminal Gate A.3 business task cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.record_variant='business-task.work-order.live/1' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
      OR NEW.capability_version_id IS DISTINCT FROM OLD.capability_version_id
      OR NEW.expert_catalog_version_id IS DISTINCT FROM OLD.expert_catalog_version_id
      OR NEW.harness_version_id IS DISTINCT FROM OLD.harness_version_id
      OR NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id
      OR NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash
      OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
      OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
      OR NEW.expert_target IS DISTINCT FROM OLD.expert_target
      OR NEW.permission_scope IS DISTINCT FROM OLD.permission_scope
      OR NEW.audience_scope IS DISTINCT FROM OLD.audience_scope
      OR NEW.budget IS DISTINCT FROM OLD.budget
      OR NEW.simulation IS DISTINCT FROM OLD.simulation
      OR NEW.runtime_mode IS DISTINCT FROM OLD.runtime_mode
      OR NEW.business_decision_allowed IS DISTINCT FROM OLD.business_decision_allowed
      OR NEW.record_variant IS DISTINCT FROM OLD.record_variant
      OR NEW.semantic_fingerprint IS DISTINCT FROM OLD.semantic_fingerprint
      OR NEW.gate_a3_authority_digest IS DISTINCT FROM OLD.gate_a3_authority_digest
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Gate A.3 business task identity and authority are immutable';
    END IF;
    IF OLD.status IN ('completed','failed','canceled') THEN
      IF (to_jsonb(NEW)-ARRAY['aggregate_version','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['aggregate_version','updated_at']) THEN
        RETURN NEW;
      END IF;
      -- Approval rejection currently records the failed status first, then fills
      -- the immutable public failure result once in the same transaction.
      IF OLD.status='failed' AND NEW.status='failed'
        AND OLD.result IS NULL AND OLD.result_record_variant IS NULL
        AND NEW.result IS NOT NULL
        AND NEW.result_record_variant='business-task-result.work-order.live/1'
        AND (to_jsonb(NEW)-ARRAY['result','result_record_variant','aggregate_version','updated_at'])
          IS NOT DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['result','result_record_variant','aggregate_version','updated_at']) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'terminal Gate A.3 business task authority is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS gate_a3_terminal_task_result_immutable ON business_tasks;
CREATE TRIGGER gate_a3_terminal_task_result_immutable
  BEFORE UPDATE OR DELETE ON business_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_gate_a3_terminal_task_result_immutable();

CREATE OR REPLACE FUNCTION ensure_gate_a_live_task_publication_terminal() RETURNS trigger AS $$
BEGIN
  IF NEW.record_variant='business-task.live/1' AND NEW.status='completed' AND (
    NOT EXISTS (SELECT 1 FROM gate_a_live_results result
      WHERE result.tenant_id=NEW.tenant_id AND result.business_task_id=NEW.id
        AND result.publication_state='published')
    OR EXISTS (SELECT 1 FROM gate_a_live_claims claim
      WHERE claim.tenant_id=NEW.tenant_id AND claim.business_task_id=NEW.id
        AND claim.publication_state<>'published')
    OR EXISTS (SELECT 1 FROM gate_a_live_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id
        AND (evidence.publication_state<>'published' OR NOT evidence.accessible))
    OR EXISTS (SELECT 1 FROM gate_a_live_evidence_links link
      WHERE link.tenant_id=NEW.tenant_id AND link.business_task_id=NEW.id
        AND link.publication_state<>'published')
    OR NOT EXISTS (SELECT 1 FROM gate_a_live_report_publish_intents intent
      WHERE intent.tenant_id=NEW.tenant_id AND intent.business_task_id=NEW.id
        AND intent.status='published')
    OR NOT EXISTS (SELECT 1 FROM gate_a_live_reports report
      WHERE report.tenant_id=NEW.tenant_id AND report.business_task_id=NEW.id)
  ) THEN
    RAISE EXCEPTION 'completed Gate A live task requires one atomic published result/evidence/report authority';
  END IF;
  IF NEW.record_variant='business-task.work-order.live/1' AND NEW.status='completed' AND (
    (SELECT count(*) FROM gate_a3_work_order_results result
      WHERE result.tenant_id=NEW.tenant_id AND result.business_task_id=NEW.id) <> 1
    OR (SELECT count(*) FROM gate_a3_connector_source_snapshots snapshot
      WHERE snapshot.tenant_id=NEW.tenant_id AND snapshot.business_task_id=NEW.id) <> 1
    OR (SELECT count(*) FROM gate_a3_work_order_explanations explanation
      WHERE explanation.tenant_id=NEW.tenant_id AND explanation.business_task_id=NEW.id) <> 1
    OR (SELECT count(*) FROM gate_a3_connector_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id) <> 10
    OR (SELECT count(*) FROM gate_a3_connector_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id
        AND evidence.locator_kind='connector_snapshot_whole' AND evidence.field_name IS NULL) <> 1
    OR (SELECT count(*) FROM gate_a3_connector_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id
        AND evidence.locator_kind='connector_snapshot_field'
        AND evidence.field_name IN ('workOrderRef','status','planQty','completedQty','unit',
          'plannedStart','plannedEnd','updatedAt','sourceRevision')) <> 9
    OR EXISTS (SELECT 1 FROM gate_a3_connector_evidence evidence
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id
        AND (NOT evidence.accessible
          OR (evidence.locator_kind='connector_snapshot_field'
            AND evidence.field_name NOT IN ('workOrderRef','status','planQty','completedQty','unit',
              'plannedStart','plannedEnd','updatedAt','sourceRevision'))))
    OR EXISTS (SELECT 1
      FROM gate_a3_connector_evidence evidence
      JOIN gate_a3_work_order_results result
        ON result.tenant_id=evidence.tenant_id AND result.business_task_id=evidence.business_task_id
      WHERE evidence.tenant_id=NEW.tenant_id AND evidence.business_task_id=NEW.id
        AND (evidence.connector_source_snapshot_id<>result.connector_source_snapshot_id
          OR evidence.connector_invocation_id<>result.connector_invocation_id
          OR evidence.effect_id<>result.effect_id))
    OR EXISTS (SELECT 1
      FROM gate_a3_work_order_results result
      JOIN gate_a3_connector_source_revocations revocation
        ON revocation.tenant_id=result.tenant_id
        AND revocation.business_task_id=result.business_task_id
        AND revocation.connector_source_snapshot_id=result.connector_source_snapshot_id
      WHERE result.tenant_id=NEW.tenant_id AND result.business_task_id=NEW.id
        AND revocation.principal_id=NEW.requester_id)
  ) THEN
    RAISE EXCEPTION 'completed Gate A Work Order task requires one snapshot, one explanation, one result, exact 1 whole + 9 field Evidence, and current source access';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gate_a_live_task_publication_terminal_guard ON business_tasks;
CREATE CONSTRAINT TRIGGER gate_a_live_task_publication_terminal_guard
  AFTER INSERT OR UPDATE ON business_tasks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_gate_a_live_task_publication_terminal();
