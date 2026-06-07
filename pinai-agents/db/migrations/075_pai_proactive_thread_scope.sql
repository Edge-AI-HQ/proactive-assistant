-- Proactive agent: add a per-session/thread dimension.
--
-- The proactive infra (069/070) was a per-user SINGLETON: one inbox, one
-- lease, one cursor, all keyed by user_id alone, with the implicit thread
-- `proactive-<user_id>`. We're collapsing main chat + card execution onto
-- this same infra (one agent link, listening is a per-session toggle), so it
-- must host MULTIPLE sessions per user:
--   * main   = `proactive-<user_id>`        (singleton, heartbeat-capable)
--   * card   = `card-thread-<card_id>`      (per card, listening off)
--
-- thread_id becomes part of the FIFO key, the processing lease, and the
-- window cursor — so different threads of the same user drain in parallel
-- (a main heartbeat and a card execution don't block each other) while a
-- single thread still serializes one turn at a time.
--
-- Backfill: existing inbox/state rows ARE the main thread → `proactive-<user_id>`.
-- RLS is unaffected (policies key on user_id; 069 covers the new column).

-- ── pai_proactive_inbox: thread-scoped FIFO ──
ALTER TABLE pai_proactive_inbox ADD COLUMN thread_id TEXT;
UPDATE pai_proactive_inbox SET thread_id = 'proactive-' || user_id WHERE thread_id IS NULL;
ALTER TABLE pai_proactive_inbox ALTER COLUMN thread_id SET NOT NULL;

-- FIFO pending scan is now per (user, thread): "next unconsumed item for
-- this thread, oldest first".
DROP INDEX IF EXISTS idx_pai_proactive_inbox_pending;
CREATE INDEX idx_pai_proactive_inbox_pending
  ON pai_proactive_inbox (user_id, thread_id, id)
  WHERE consumed_at IS NULL;

-- ── pai_proactive_state: lease + cursor become per (user, thread) ──
ALTER TABLE pai_proactive_state ADD COLUMN thread_id TEXT;
UPDATE pai_proactive_state SET thread_id = 'proactive-' || user_id WHERE thread_id IS NULL;
ALTER TABLE pai_proactive_state ALTER COLUMN thread_id SET NOT NULL;
ALTER TABLE pai_proactive_state DROP CONSTRAINT pai_proactive_state_pkey;
ALTER TABLE pai_proactive_state ADD PRIMARY KEY (user_id, thread_id);

-- ── pai_proactive_events: per-session history scan ──
CREATE INDEX idx_pai_proactive_events_user_thread_created
  ON pai_proactive_events (user_id, thread_id, created_at DESC);
