-- Proactive agent: per-turn decision log + say_to_user delivery ledger.
-- docs/plans/2026-05-23-proactive-agent-impl.mdx (组件 G).
--
-- One row per agent turn outcome:
--   * kind='silent' — the turn ran but the agent chose not to reach out
--     (the majority class; the negative-label corpus for future training).
--   * kind='say'    — the agent called say_to_user. message holds the text;
--     delivered / delivered_at track APNs / live-stream delivery.
--   * kind='action' — the agent took a side-effecting action (draft, etc.);
--     outcome carries a short summary.
--
-- Visibility of the conversation is NOT served from here — the frontend reads
-- the langgraph checkpoint via /api/proactive/history. This table is the
-- queryable flat index for delivery tracking + training labels (the full
-- trajectory lives in the checkpoint + LangSmith trace).

CREATE TABLE pai_proactive_events (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('silent', 'say', 'action')),
  message       TEXT,
  window_start  TIMESTAMPTZ,
  window_end    TIMESTAMPTZ NOT NULL,
  outcome       JSONB,
  delivered     BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pai_proactive_events_user_created
  ON pai_proactive_events (user_id, created_at DESC);

-- ── RLS — matches 023_pai_rls.sql / 035_pai_chat_threads.sql pattern ──
ALTER TABLE pai_proactive_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_proactive_events_user_scope ON pai_proactive_events
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_proactive_events_service_role ON pai_proactive_events
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
