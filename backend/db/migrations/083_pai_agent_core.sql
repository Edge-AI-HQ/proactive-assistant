-- Agent Core: unified actor-model execution kernel.
-- docs/plans/2026-06-04-agentrun-control-plane.mdx
--
-- Three tables model one actor:
--   pai_agent_sessions — a Session (= actor instance). session_id is the
--     langgraph thread_id, the per-session串行 lease key, and the mailbox
--     owner. Holds the per-drain lease (lease_owner / lease_expires_at,
--     used with fencing — writes check owner so an expired owner can't
--     double-write).
--   pai_agent_messages — the mailbox. ANY input is one Message: user
--     messages, system heartbeats, cron triggers, HITL tool decisions.
--     `role` is what the LLM sees (always 'user'); `source` is what the
--     worker routes/accounts on (proactive silent/cursor bookkeeping reads
--     source, NOT role). A Run consumes ALL pending messages at once
--     (merge); consumed_at is set after the Run returns.
--   pai_agent_runs — one execution. status machine + awaiting_input HITL
--     fields (stop_reason / pending_action). batch one-shot runs have
--     session_id NULL.
--
-- Frames are NOT persisted here: live streaming goes through FrameBus
-- (in-memory dev / Redis pub/sub prod); on reconnect the client shows a
-- waiting state and reads the final result from pai_chat_messages. So
-- there is deliberately no frames table — see §四.4 of the plan.
--
-- RLS mirrors 069_pai_proactive_inbox_state.sql: per-user scope for app
-- connections (app.user_id set via user_scoped_tx) + a service_role
-- catch-all for the worker's cross-user drain (service_tx, no app.user_id).

CREATE TABLE pai_agent_sessions (
  session_id        TEXT PRIMARY KEY,                    -- main-<uid>-<rand> / card-thread-<id> / proactive-<uid>
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_kind        TEXT NOT NULL,
  -- per-drain lease: serializes the worker's drain of this session
  -- cluster-wide. fencing: write ops check lease_owner so an expired
  -- owner whose lease was stolen cannot keep writing.
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pai_agent_messages (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'user',          -- given to the LLM: always 'user'
  source          TEXT NOT NULL CHECK (source IN (
                    'user', 'heartbeat', 'cron', 'system_event',
                    'card_bootstrap', 'tool_decision')),  -- for the worker: routing / accounting
  content         TEXT,                                  -- user text; heartbeat = NULL (window computed at drain)
  meta            JSONB,                                 -- card_context; tool_decision = {tool_use_id, decision, message}
  idempotency_key TEXT,                                  -- dedupe re-delivery / FE retry
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at     TIMESTAMPTZ,                           -- set after the Run that merged this message returns
  run_id          UUID                                   -- which Run consumed it (audit; no FK — run created after enqueue)
);

-- FIFO pending scan: oldest unconsumed first, per session.
CREATE INDEX idx_pai_agent_messages_pending
  ON pai_agent_messages (session_id, id)
  WHERE consumed_at IS NULL;

-- Idempotent enqueue: same (session, idempotency_key) can't double-insert.
CREATE UNIQUE INDEX idx_pai_agent_messages_idem
  ON pai_agent_messages (session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE pai_agent_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT,                                  -- conversational has it; batch one-shot NULL
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_kind      TEXT NOT NULL,
  parent_run_id   UUID,                                  -- subagent fallback (nullable; subagents default to in-chat)
  trigger         TEXT NOT NULL,                         -- dominant source of the merged batch (user > others)
  status          TEXT NOT NULL CHECK (status IN (
                    'pending', 'running', 'awaiting_input',
                    'succeeded', 'failed', 'cancelled')),
  stop_reason     TEXT,                                  -- awaiting_input: 'requires_action'; terminal: 'end_turn' etc.
  pending_action  JSONB,                                 -- awaiting_input: {tool_use_id, tool_name, args_preview}
  result          JSONB,                                 -- batch structured result / conversational terminal summary
  error           TEXT,
  cancel_reason   TEXT,                                  -- 'user_cancel' | 'user_interrupt'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ
);

-- Per-session history (newest first) for run lookups.
CREATE INDEX idx_pai_agent_runs_session
  ON pai_agent_runs (session_id, created_at DESC);

-- Active runs for the /api/agent-runs indicator + reaper scan.
CREATE INDEX idx_pai_agent_runs_active
  ON pai_agent_runs (user_id, status)
  WHERE status IN ('pending', 'running', 'awaiting_input');

-- ── RLS — mirrors 023_pai_rls.sql / 069_pai_proactive_inbox_state.sql ──
ALTER TABLE pai_agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_agent_sessions_user_scope ON pai_agent_sessions
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_agent_sessions_service_role ON pai_agent_sessions
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

CREATE POLICY pai_agent_messages_user_scope ON pai_agent_messages
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_agent_messages_service_role ON pai_agent_messages
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

CREATE POLICY pai_agent_runs_user_scope ON pai_agent_runs
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_agent_runs_service_role ON pai_agent_runs
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
