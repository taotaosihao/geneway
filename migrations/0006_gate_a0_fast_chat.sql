ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sequence bigint,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed','streaming','failed','canceled')),
  ADD COLUMN IF NOT EXISTS content_version bigint NOT NULL DEFAULT 0 CHECK (content_version >= 0),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE messages SET completed_at=created_at WHERE completed_at IS NULL AND status='completed';

WITH ranked AS (
  SELECT tenant_id,id,row_number() OVER (PARTITION BY tenant_id,conversation_id ORDER BY created_at,id) AS sequence
  FROM messages
)
UPDATE messages SET sequence=ranked.sequence FROM ranked
WHERE messages.tenant_id=ranked.tenant_id AND messages.id=ranked.id AND messages.sequence IS NULL;

CREATE OR REPLACE FUNCTION assign_conversation_message_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id),hashtext(NEW.conversation_id));
  IF NEW.sequence IS NULL THEN
    SELECT coalesce(max(sequence),0)+1 INTO NEW.sequence FROM messages
      WHERE tenant_id=NEW.tenant_id AND conversation_id=NEW.conversation_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messages_assign_sequence ON messages;
CREATE TRIGGER messages_assign_sequence BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION assign_conversation_message_sequence();

ALTER TABLE messages ALTER COLUMN sequence SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_sequence
  ON messages(tenant_id,conversation_id,sequence);

CREATE TABLE IF NOT EXISTS prompt_policy_versions (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  policy_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,policy_id,version)
);

CREATE TABLE IF NOT EXISTS capability_release_records (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  capability_version_id text NOT NULL,
  prompt_policy_version_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','shadow','internal')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  previous_release_id text,
  actor text NOT NULL,
  gate_evidence jsonb NOT NULL,
  gate_evidence_digest text NOT NULL CHECK (gate_evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,capability_version_id,sequence),
  FOREIGN KEY (tenant_id,capability_version_id) REFERENCES capability_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,prompt_policy_version_id) REFERENCES prompt_policy_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,previous_release_id) REFERENCES capability_release_records(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS capability_active_releases (
  tenant_id text NOT NULL REFERENCES tenants(id),
  capability_id text NOT NULL,
  release_id text NOT NULL,
  pointer_version bigint NOT NULL DEFAULT 1 CHECK (pointer_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,capability_id),
  FOREIGN KEY (tenant_id,release_id) REFERENCES capability_release_records(tenant_id,id)
);

CREATE OR REPLACE FUNCTION validate_capability_release_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_state text;
  previous_sequence bigint;
  previous_capability_version_id text;
BEGIN
  IF NEW.sequence=1 THEN
    IF NEW.state<>'draft' OR NEW.previous_release_id IS NOT NULL THEN
      RAISE EXCEPTION 'first capability release must be draft';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.previous_release_id IS NULL THEN RAISE EXCEPTION 'capability release transition requires previous release'; END IF;
  SELECT state,sequence,capability_version_id INTO previous_state,previous_sequence,previous_capability_version_id
    FROM capability_release_records WHERE tenant_id=NEW.tenant_id AND id=NEW.previous_release_id;
  IF previous_state IS NULL OR previous_capability_version_id<>NEW.capability_version_id OR previous_sequence+1<>NEW.sequence
    OR NOT ((previous_state='draft' AND NEW.state='shadow') OR (previous_state='shadow' AND NEW.state='internal')) THEN
    RAISE EXCEPTION 'invalid capability release transition';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS capability_release_records_transition ON capability_release_records;
CREATE TRIGGER capability_release_records_transition BEFORE INSERT ON capability_release_records
FOR EACH ROW EXECUTE FUNCTION validate_capability_release_transition();

CREATE OR REPLACE FUNCTION validate_capability_active_pointer_cas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_release text;
  selected_state text;
  selected_sequence bigint;
  selected_capability_id text;
BEGIN
  SELECT release.previous_release_id,release.state,release.sequence,capability.capability_id
    INTO previous_release,selected_state,selected_sequence,selected_capability_id
    FROM capability_release_records release
    JOIN capability_versions capability ON capability.tenant_id=release.tenant_id AND capability.id=release.capability_version_id
    WHERE release.tenant_id=NEW.tenant_id AND release.id=NEW.release_id;
  IF selected_state IS NULL OR selected_capability_id<>NEW.capability_id THEN
    RAISE EXCEPTION 'capability active release pointer target is invalid';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.pointer_version<>1 OR selected_state<>'draft' OR selected_sequence<>1 OR previous_release IS NOT NULL THEN
      RAISE EXCEPTION 'initial capability active release pointer must select the first draft';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.pointer_version<>OLD.pointer_version+1 OR previous_release<>OLD.release_id OR NEW.capability_id<>OLD.capability_id THEN
    RAISE EXCEPTION 'capability active release pointer CAS failed';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS capability_active_releases_cas ON capability_active_releases;
CREATE TRIGGER capability_active_releases_cas BEFORE UPDATE ON capability_active_releases
FOR EACH ROW EXECUTE FUNCTION validate_capability_active_pointer_cas();

CREATE TABLE IF NOT EXISTS model_invocations (
  tenant_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL,
  user_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  requester_id text NOT NULL,
  capability_version_id text NOT NULL,
  prompt_policy_version_id text NOT NULL,
  logical_model_policy text NOT NULL CHECK (logical_model_policy='general.chat.standard'),
  route_profile text NOT NULL CHECK (route_profile='codex_subscription_dev'),
  provider_revision text,
  model_revision text,
  data_class text NOT NULL CHECK (data_class IN ('C0','C1')),
  redaction_policy_version text NOT NULL,
  budget jsonb NOT NULL,
  deadline timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','cancel_requested','completed','canceled','failed')),
  execution_fence bigint NOT NULL DEFAULT 1 CHECK (execution_fence > 0),
  usage jsonb,
  error_class text CHECK (error_class IS NULL OR error_class IN (
    'MODEL_ROUTE_UNAVAILABLE','MODEL_AUTH_FAILED','MODEL_QUOTA','MODEL_TIMEOUT',
    'MODEL_STREAM_INTERRUPTED','MODEL_PROTOCOL_VIOLATION','CHAT_BUSY')),
  last_event_cursor bigint NOT NULL DEFAULT 0 CHECK (last_event_cursor >= 0),
  context_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_truncated boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,assistant_message_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY (tenant_id,user_message_id) REFERENCES messages(tenant_id,id),
  FOREIGN KEY (tenant_id,assistant_message_id) REFERENCES messages(tenant_id,id),
  FOREIGN KEY (tenant_id,capability_version_id) REFERENCES capability_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,prompt_policy_version_id) REFERENCES prompt_policy_versions(tenant_id,id)
);

CREATE UNIQUE INDEX IF NOT EXISTS model_invocations_one_active_per_conversation
  ON model_invocations(tenant_id,conversation_id)
  WHERE status IN ('pending','running','cancel_requested');

CREATE TABLE IF NOT EXISTS chat_idempotency_records (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  conversation_id text NOT NULL,
  operation text NOT NULL CHECK (operation='chat-run.create'),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  model_invocation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,principal_id,conversation_id,operation,idempotency_key),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES model_invocations(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS chat_turn_dispatches (
  tenant_id text NOT NULL,
  id text NOT NULL,
  principal_id text NOT NULL,
  conversation_id text NOT NULL,
  model_invocation_id text NOT NULL,
  assistant_message_id text NOT NULL,
  attempt_id text,
  execution_fence bigint NOT NULL DEFAULT 1 CHECK (execution_fence > 0),
  deadline timestamptz NOT NULL,
  lease_until timestamptz,
  worker_instance_id text,
  status text NOT NULL CHECK (status IN ('pending','leased','running','cancel_requested','completed','canceled','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,model_invocation_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES model_invocations(tenant_id,id),
  FOREIGN KEY (tenant_id,assistant_message_id) REFERENCES messages(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS model_invocation_token_authorizations (
  tenant_id text NOT NULL,
  jti text NOT NULL,
  model_invocation_id text NOT NULL,
  dispatch_id text NOT NULL,
  execution_fence bigint NOT NULL CHECK (execution_fence > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,jti),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES model_invocations(tenant_id,id),
  FOREIGN KEY (tenant_id,dispatch_id) REFERENCES chat_turn_dispatches(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS chat_turn_outbox (
  tenant_id text NOT NULL,
  id text NOT NULL,
  dispatch_id text NOT NULL,
  model_invocation_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type='chat.turn.requested'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,model_invocation_id),
  FOREIGN KEY (tenant_id,dispatch_id) REFERENCES chat_turn_dispatches(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES model_invocations(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS chat_run_events (
  cursor bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL,
  model_invocation_id text NOT NULL,
  assistant_message_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('run.started','message.delta','message.completed','run.canceled','run.failed')),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,model_invocation_id,sequence),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES model_invocations(tenant_id,id),
  FOREIGN KEY (tenant_id,assistant_message_id) REFERENCES messages(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS model_gateway_audit (
  tenant_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL,
  model_invocation_id text NOT NULL,
  route_profile text NOT NULL,
  provider_revision text,
  model_revision text,
  outcome text NOT NULL,
  usage jsonb,
  gateway_receipt_jti text NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  attested boolean NOT NULL CHECK (attested),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,gateway_receipt_jti),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),
  FOREIGN KEY (tenant_id,model_invocation_id) REFERENCES model_invocations(tenant_id,id)
);

CREATE OR REPLACE FUNCTION reject_capability_release_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'capability release records are append-only';
END $$;

DROP TRIGGER IF EXISTS capability_release_records_append_only ON capability_release_records;
CREATE TRIGGER capability_release_records_append_only
  BEFORE UPDATE OR DELETE ON capability_release_records
  FOR EACH ROW EXECUTE FUNCTION reject_capability_release_mutation();

INSERT INTO capability_versions(tenant_id,id,capability_id,version,spec)
VALUES ('tenant_local','capability_xiaowei_chat_v1','xiaowei.chat.v1',1,
  '{"logicalModelPolicy":"general.chat.standard","dataClasses":["C0","C1"],"toolChoice":"none","context":{"maxMessages":24,"maxBytes":65536}}')
ON CONFLICT DO NOTHING;

INSERT INTO prompt_policy_versions(tenant_id,id,policy_id,version,policy)
VALUES ('tenant_local','prompt_xiaowei_chat_system_v1','xiaowei.chat.system',1,
  '{"system":"你是小纬，geneway 的制造业数字员工。清晰、诚实地回答普通文本问题；不得声称使用工具、企业知识、联网搜索或执行生产写操作。"}')
ON CONFLICT DO NOTHING;

INSERT INTO capability_release_records
  (tenant_id,id,capability_version_id,prompt_policy_version_id,state,sequence,previous_release_id,actor,gate_evidence,gate_evidence_digest)
-- Gate A0 authority brief SHA-256; draft records authorization, not release readiness.
VALUES ('tenant_local','release_xiaowei_chat_v1_draft','capability_xiaowei_chat_v1','prompt_xiaowei_chat_system_v1','draft',1,NULL,
  'user@source-thread:019f880e-bac8-7412-a129-68db9bf6506a',
  '{"kind":"authority-document","document":"gate-a0-fast-chat/brief.md","authorizationRef":"source-thread:019f880e-bac8-7412-a129-68db9bf6506a","sha256":"a6225da9a53c99583ce8459e6fb2e1d5af6366db859e415307e1c6b4994556ca"}',
  'a6225da9a53c99583ce8459e6fb2e1d5af6366db859e415307e1c6b4994556ca')
ON CONFLICT DO NOTHING;

INSERT INTO capability_active_releases(tenant_id,capability_id,release_id,pointer_version)
VALUES ('tenant_local','xiaowei.chat.v1','release_xiaowei_chat_v1_draft',1)
ON CONFLICT DO NOTHING;
