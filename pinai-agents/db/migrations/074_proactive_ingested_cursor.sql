-- Proactive agent: consume the timeline by INGESTION order, not occurred_at.
--
-- pai_proactive_state.last_tick_at was the timeline window cursor, but the
-- tick queried `[last_tick_at, now]` filtered by `occurred_at`. That missed
-- two cases the proactive agent must react to:
--   1. A just-connected data connector backfills "recent N" items whose
--      occurred_at is in the PAST (emails/events from days/weeks ago) but
--      ingested_at = now — they fell outside the occurred_at window.
--   2. Events that arrived while the heartbeat was OFF (it's a product
--      toggle, default off) never got consumed.
--
-- The fix (services/proactive_loop.py) reinterprets last_tick_at as the
-- INGESTED-AT consumption cursor: each tick gathers events with
-- `ingested_at ∈ (last_tick_at, now]` into one catch-up message and advances
-- the cursor. Backdated + backlog events are now surfaced (the heartbeat
-- formatter tags backfilled events — ingested long after they occurred —
-- with their full date so the agent distinguishes "just happened" from
-- "just connected historical data").
--
-- Bootstrap: a FRESH state row should look back so a connector connected
-- shortly before the user enables the heartbeat still gets caught. New rows
-- default to NOW() - 7 days. Existing rows are left at their current value
-- (they've effectively already "seen" their live window — no retroactive
-- replay on deploy).

ALTER TABLE pai_proactive_state
  ALTER COLUMN last_tick_at SET DEFAULT (NOW() - INTERVAL '7 days');

COMMENT ON COLUMN pai_proactive_state.last_tick_at IS
  'Timeline consumption cursor (ingested_at lower bound). Each proactive '
  'tick gathers events ingested in (last_tick_at, now] and advances it. '
  'Fresh rows bootstrap to NOW()-7d to catch a recent connector backfill.';
