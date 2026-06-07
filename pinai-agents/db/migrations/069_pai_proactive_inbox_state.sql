-- Proactive agent: unified input queue + per-user processing state.
-- docs/plans/2026-05-23-proactive-agent-impl.mdx (决策 1).
--
-- pai_proactive_inbox: one ordered queue per user holding BOTH the system
--   heartbeat ticks and the user's own messages. The process loop drains it
--   FIFO, one item = one agent turn (no coalescing). A tick is a marker
--   (content NULL); its window is [last_tick_at, enqueued_at] computed at
--   drain time. A user item carries the message text.
--
-- pai_proactive_state: one row per user holding (a) the per-user processing
--   lease that serializes the agent loop — the SINGLE primitive that makes
--   "same user never runs two turns at once" true, killing tick overlap —
--   and (b) last_tick_at, the timeline window cursor, advanced only after a
--   tick turn completes so a skipped/crashed window folds into the next.
--
-- consume-on-completion: an item's consumed_at is set only after its turn
-- finishes. A crash leaves the item pending (consumed_at NULL); the next
-- lease holder reprocesses it FIFO. The lease (lease_owner / lease_expires_at)
-- is reclaimable once expired, so a dead web instance is auto-recovered.

CREATE TABLE pai_proactive_inbox (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('tick', 'user')),
  -- user: message text; tick: NULL (window = [last_tick_at, enqueued_at]).
  content       TEXT,
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at   TIMESTAMPTZ,
  CHECK (kind <> 'user' OR content IS NOT NULL)
);

-- FIFO pending scan: "next unconsumed item for this user, oldest first".
CREATE INDEX idx_pai_proactive_inbox_pending
  ON pai_proactive_inbox (user_id, id)
  WHERE consumed_at IS NULL;

CREATE TABLE pai_proactive_state (
  user_id                    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Timeline window cursor. The next tick queries [last_tick_at, tick.enqueued_at].
  last_tick_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Per-user processing lease (cluster-wide serialization, multi-instance safe).
  processing_lease_owner     TEXT,
  processing_lease_expires_at TIMESTAMPTZ,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── RLS — matches 023_pai_rls.sql / 035_pai_chat_threads.sql pattern ──
ALTER TABLE pai_proactive_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_proactive_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_proactive_inbox_user_scope ON pai_proactive_inbox
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_proactive_inbox_service_role ON pai_proactive_inbox
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

CREATE POLICY pai_proactive_state_user_scope ON pai_proactive_state
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_proactive_state_service_role ON pai_proactive_state
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
