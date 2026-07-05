-- Generation context anchor — the ONLY state behind the cache-efficient
-- generator context (design: docs/plans/2026-06-23-proactive-card-generation
-- §4.2 "anchor 即状态").
--
-- The generator's prompt prefix (the arrival-ordered event log) is rebuilt
-- deterministically from (anchor, now) on every tick — byte-identical across
-- ticks, so the provider-side prompt cache hits. No message log is persisted:
-- one timestamp IS the state. `last_prompt_tokens` carries the previous run's
-- actual usage so the reset check (tokens > budget OR anchor age > max) uses
-- real numbers, not estimates.
--
-- Reset = UPDATE anchor to now() (下一 tick 从 (now − LOOKBACK) 全新重建).
-- Concurrency is optimistic: two overlapping runs both finish; the later
-- anchor write wins and the loser costs one cache miss on the next tick —
-- context is always rebuildable, so there is no correctness risk.

CREATE TABLE pai_generation_context (
  user_id            BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  anchor             TIMESTAMPTZ NOT NULL,
  last_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS — per-user scope, empty-string-safe (NULLIF) + service_role fallback
-- + FORCE (same recipe as 112). New table post-104 → pai_app auto-granted.
ALTER TABLE pai_generation_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_generation_context FORCE ROW LEVEL SECURITY;

CREATE POLICY pai_generation_context_user_scope ON pai_generation_context
  FOR ALL TO PUBLIC
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint);

CREATE POLICY pai_generation_context_service_role ON pai_generation_context
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

-- Arrival-axis index: the generator's log rebuild scans
-- `WHERE user_id = ? AND recorded_at ∈ (anchor − LOOKBACK, now] ORDER BY
-- recorded_at, id` on every tick — pai_events so far only indexes the
-- occurred_at axis (111), so the arrival scan needs its own.
CREATE INDEX idx_pai_events_arrival ON pai_events (user_id, recorded_at, id);
