-- Supersede producer (design doc 6.3): track REAL content changes on the
-- apps raw domain so the projector can re-project them as supersede chains.
--
-- Before this, a re-ingested item (calendar reschedule, edited email draft)
-- updated the L0 row in place (ON CONFLICT DO UPDATE) but its L1 event stayed
-- frozen forever: the projector only scans rows with no event yet, and a
-- re-append hits the events dedupe and no-ops. The whole supersede machinery
-- (columns / chain / repo method) had zero producers.
--
-- content_updated_at semantics:
--   * NULL      — content never changed since insert (the overwhelmingly
--                 common case; a re-sync that carries an identical payload
--                 does NOT touch it — see generic_ingest's conditional CASE).
--   * NOT NULL  — the payload genuinely changed at that instant. The
--                 projector re-projects rows where content_updated_at is
--                 newer than the current event's recorded_at: append a new
--                 event revision + supersede the old one (append-only
--                 correction, design §6.3), cancelled items become tombstones.
--
-- ingested_at keeps its existing meaning (last sync touch, updated on every
-- conflict) — content_updated_at only moves on real change, which is what
-- makes the re-projection scan cheap and non-churning.
--
-- Device domain deliberately not covered: device rows are append-shaped
-- observations (dedupe collisions re-send the same reading), no update
-- semantics to track. Extend there if a mutable device kind ever appears.

ALTER TABLE pai_raw_apps ADD COLUMN content_updated_at TIMESTAMPTZ;

-- Re-projection scan: "changed rows for this user" (NULLs excluded — the
-- partial index stays tiny relative to the table).
CREATE INDEX idx_pai_raw_apps_content_updated
  ON pai_raw_apps (user_id, content_updated_at)
  WHERE content_updated_at IS NOT NULL;
