-- Collapse pai_chat_threads to one active main thread per user.
--
-- The frontend (post-053) treats main chat as a singleton per user. This
-- migration:
--   1. For each user, picks the most recently active non-archived main
--      thread (last_message_at DESC NULLS LAST, then message_count
--      DESC, then created_at DESC).
--   2. Cascade-deletes the LangGraph checkpoint data for the dropped
--      thread_ids — the user can no longer reach those conversations,
--      and keeping the rows wastes storage.
--   3. Deletes the redundant pai_chat_threads rows themselves.
--   4. Adds a partial UNIQUE index enforcing at-most-one active main
--      thread per user going forward.
--
-- Archived main rows are intentionally left alone — they were already
-- invisible to the simplified API; dropping them now isn't required
-- for correctness and would discard user-archived history.
-- Card threads (kind='card') are untouched: keyed by card_id, multiple
-- per user is the design.

-- Stash the doomed thread_ids first so the cross-schema cascade reads
-- from a stable set. yoyo wraps each migration in a single tx, so the
-- temp table is visible for all statements below and auto-drops on
-- successful COMMIT.
CREATE TEMP TABLE _dropped_main_threads (thread_id TEXT PRIMARY KEY)
  ON COMMIT DROP;

WITH ranked AS (
  SELECT
    user_id,
    thread_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY last_message_at DESC NULLS LAST,
               message_count DESC,
               created_at DESC
    ) AS rn
  FROM pai_chat_threads
  WHERE kind = 'main' AND archived = FALSE
)
INSERT INTO _dropped_main_threads (thread_id)
SELECT thread_id FROM ranked WHERE rn > 1;

-- Cascade-delete LangGraph checkpoint state for the dropped threads.
-- Guarded by EXISTS so the migration is safe on a fresh DB where the
-- chat process hasn't booted yet (langgraph schema absent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'langgraph' AND table_name = 'checkpoints'
  ) THEN
    DELETE FROM langgraph.checkpoints
    WHERE thread_id IN (SELECT thread_id FROM _dropped_main_threads);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'langgraph' AND table_name = 'checkpoint_writes'
  ) THEN
    DELETE FROM langgraph.checkpoint_writes
    WHERE thread_id IN (SELECT thread_id FROM _dropped_main_threads);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'langgraph' AND table_name = 'checkpoint_blobs'
  ) THEN
    DELETE FROM langgraph.checkpoint_blobs
    WHERE thread_id IN (SELECT thread_id FROM _dropped_main_threads);
  END IF;
END$$;

-- Drop the redundant metadata rows themselves.
DELETE FROM pai_chat_threads
WHERE thread_id IN (SELECT thread_id FROM _dropped_main_threads)
  AND kind = 'main' AND archived = FALSE;

-- Enforce one-active-main per user going forward. Partial unique index
-- so archived rows don't collide with a new active row for the same
-- user if we ever surface unarchive.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_chat_threads_one_active_main_per_user
  ON pai_chat_threads (user_id)
  WHERE kind = 'main' AND archived = FALSE;
