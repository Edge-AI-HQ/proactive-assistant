-- Add 'proactive' as a third chat thread kind.
--
-- The proactive agent (docs/plans/2026-05-23-proactive-agent-impl.mdx) is a
-- single, continuous per-user agent. Its conversation lives in the same
-- langgraph.checkpoints store as main/card chat, keyed by a deterministic
-- singleton thread_id `proactive-<user_id>` (one per user — no uuid suffix
-- needed since there is exactly one proactive thread per user).
--
-- Two CHECK constraints from 035_pai_chat_threads.sql must widen:
--   * the kind enum check (column-level, auto-named pai_chat_threads_kind_check)
--   * the thread_id shape check (table-level, auto-named pai_chat_threads_check)
-- We drop + re-add both with explicit names so future migrations can target
-- them by name instead of relying on auto-generated identifiers.

ALTER TABLE pai_chat_threads DROP CONSTRAINT IF EXISTS pai_chat_threads_kind_check;
ALTER TABLE pai_chat_threads DROP CONSTRAINT IF EXISTS pai_chat_threads_check;

ALTER TABLE pai_chat_threads
  ADD CONSTRAINT pai_chat_threads_kind_check
  CHECK (kind IN ('main', 'card', 'proactive'));

ALTER TABLE pai_chat_threads
  ADD CONSTRAINT pai_chat_threads_shape_check
  CHECK (
    (kind = 'main' AND card_id IS NULL
       AND thread_id LIKE 'main-' || user_id::text || '-%')
    OR
    (kind = 'card' AND card_id IS NOT NULL
       AND thread_id = 'card-thread-' || card_id)
    OR
    (kind = 'proactive' AND card_id IS NULL
       AND thread_id = 'proactive-' || user_id::text)
  );
