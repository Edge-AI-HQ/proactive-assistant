-- WP2 (design §五-225): drop the subjective LLM scores, collapse curation_status.
--
-- `importance` was an LLM-assigned 0..1 score. Per the design (D³ 2505.16067 /
-- Rating Roulette 2510.27106): LLM numeric importance is high-bias and near-random
-- across runs, so we DON'T store it. Importance is now computed at retrieval time
-- from objective signals (reference_count × recency × event_type weight × semantic
-- similarity — see 116 + events.py _objective_score_sql). `confidence` was never a
-- column (it lives in `structured` as an optional weak signal), so nothing to drop
-- there.
--
-- `curation_status` (4-state: pending/active/filtered_out/archived) collapses to a
-- single `curated_at` flag (the projector→evolve handoff, design §223/§八-345):
--   * NULL          = projector just wrote it; evolve hasn't processed it (the
--                     `curated_at IS NULL` queue — a per-row flag, not a time
--                     cursor, so bi-temporal backfill / out-of-order rows are
--                     never skipped).
--   * NOT NULL      = evolve has processed it, OR a hot-path / user-explicit event
--                     that needs no evolve judgement (stamped at append).
-- The other two states are gone:
--   * filtered_out  — noise no longer gets a row. The projector simply doesn't
--                     project obvious mechanical noise (the L0 raw domain tables
--                     keep the verbatim record); whatever does land in L1 is
--                     ordered down by the objective score and reclaimed by
--                     forgetting. No `filtered_out` rows to carry.
--   * archived      — already expressed by `superseded_by_id IS NOT NULL` (the
--                     supersede chain). The redundant status is dropped.
--
-- pai_events is a new (un-shipped) table introduced on this branch (111), so this
-- is a clean forward-only contract step — no production data to preserve, but the
-- data migration below is written defensively anyway.

-- Pending-sweep index depends on curation_status — drop before the column.
DROP INDEX IF EXISTS idx_pai_events_curation;

ALTER TABLE pai_events ADD COLUMN IF NOT EXISTS curated_at TIMESTAMPTZ;

-- Carry forward any existing rows: anything past 'pending' was already handled by
-- evolve (or was a hot active row), so it's "curated"; 'pending' stays NULL.
UPDATE pai_events
   SET curated_at = COALESCE(curated_at, recorded_at)
 WHERE curation_status <> 'pending';

ALTER TABLE pai_events DROP COLUMN IF EXISTS curation_status;
ALTER TABLE pai_events DROP COLUMN IF EXISTS importance;

-- evolve's input queue: rows not yet curated (and not superseded). Replaces the
-- old curation_status='pending' partial index.
CREATE INDEX idx_pai_events_uncurated ON pai_events (user_id, occurred_at DESC)
  WHERE curated_at IS NULL AND superseded_by_id IS NULL;
