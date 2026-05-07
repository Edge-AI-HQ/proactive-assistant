-- pai_chat_threads — thread metadata + ownership index for chat sessions.
--
-- Why a separate table: `langgraph.checkpoints` is owned by the
-- langgraph-checkpoint-postgres library and we treat it as opaque
-- (the library can change its schema between versions). To answer
-- "what threads does this user have?" we need a metadata table we
-- own, indexed by user_id, with RLS isolation matching the rest
-- of pai_*. The two tables are linked by `thread_id` string equality
-- (logical join, no FK across schemas / library boundaries).
--
-- Lifecycle:
--   * web `chat-stream/init` mints sessionKey AND inserts a row here
--     before returning. If the user requested the latest main thread
--     (empty body, no localStorage), we SELECT here first.
--   * web `chat-stream/send` bumps last_message_at + message_count
--     after the stream completes (chat process writes the actual
--     LangGraph checkpoint independently — that's its concern).
--   * Listing for a thread sidebar / picker reads only this table —
--     no JOIN to langgraph.checkpoints needed.
--   * History fetch for a specific thread still goes through chat
--     /agent/chat/history → langgraph.checkpoints (unchanged).

CREATE TABLE pai_chat_threads (
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id        TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('main', 'card')),
  -- For card threads, the IntentCard id (gen.<runId>.<segment>_card_<idx>).
  -- Stored as plain TEXT — cards live inside pai_pipeline_runs.final_cards
  -- JSONB, not a normal table, so no FK target. Application enforces
  -- consistency via the CHECK below.
  card_id          TEXT,
  title            TEXT,
  archived         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at  TIMESTAMPTZ,
  message_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, thread_id),
  -- Schema-level enforcement of the thread_id naming contract used by
  -- chat.py and CardChat.tsx. Catches "wrote a thread under wrong
  -- user_id" or "kind='card' without card_id" bugs at INSERT time.
  CHECK (
    (kind = 'main' AND card_id IS NULL
       AND thread_id LIKE 'main-' || user_id::text || '-%')
    OR
    (kind = 'card' AND card_id IS NOT NULL
       AND thread_id = 'card-thread-' || card_id)
  )
);

-- Listing: "give me this user's recent (non-archived) threads, latest first".
-- Partial index on archived = FALSE keeps the list-page query laser-fast even
-- as the user's archive grows.
CREATE INDEX idx_pai_chat_threads_user_recent
  ON pai_chat_threads (user_id, last_message_at DESC NULLS LAST, created_at DESC)
  WHERE archived = FALSE;

-- "Find the chat thread for this card" — used when a card is reopened.
-- Card chat already uses deterministic thread_id (`card-thread-<cardId>`),
-- so this index is mostly for analytics + for cleaning up when a card
-- is hard-deleted.
CREATE INDEX idx_pai_chat_threads_card_id
  ON pai_chat_threads (card_id) WHERE card_id IS NOT NULL;

-- ── RLS — matches 023_pai_rls.sql pattern for every other pai_* table ──
ALTER TABLE pai_chat_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_chat_threads_user_scope ON pai_chat_threads
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_chat_threads_service_role ON pai_chat_threads
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

-- ── Backfill: scrape existing threads from langgraph.checkpoints ──
-- One-time at-migration-apply. After this, pai_chat_threads is the
-- source of truth and chat-stream/init writes new rows on its own.
--
-- Wrapped in a DO block + table-exists check so the migration is
-- safe to run on a fresh database where the chat process has never
-- booted (LangGraph creates its schema on first checkpointer init).
-- If langgraph.checkpoints is absent, no rows to backfill — this is
-- not an error, the table will be populated by chat-stream/init
-- going forward.
--
-- Two thread shapes to handle:
--   main-{user_id}-{uuid}            user_id parsed from thread_id
--   card-thread-{card_id}            user_id resolved via
--                                    pai_intent_card_state(card_id, user_id)
--
-- last_message_at on backfilled rows is set to NOW() (a single
-- "discovered at migration time" timestamp). The next chat-stream/send
-- will set it accurately from then on. Backfilled rows still sort
-- after any newly-active threads since live updates set NOW() too —
-- relative ordering is preserved.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'langgraph' AND table_name = 'checkpoints'
  ) THEN
    INSERT INTO pai_chat_threads (user_id, thread_id, kind, card_id, last_message_at, message_count)
    WITH lg_threads AS (
      SELECT
        thread_id,
        COUNT(*) AS cp_count
      FROM langgraph.checkpoints
      GROUP BY thread_id
    ),
    parsed AS (
      -- main threads
      SELECT
        CAST(split_part(thread_id, '-', 2) AS BIGINT) AS user_id,
        thread_id,
        'main'::TEXT AS kind,
        NULL::TEXT AS card_id,
        cp_count
      FROM lg_threads
      WHERE thread_id LIKE 'main-%-%'
      UNION ALL
      -- card threads — JOIN pai_intent_card_state to find owner
      SELECT
        s.user_id,
        lg.thread_id,
        'card'::TEXT AS kind,
        SUBSTRING(lg.thread_id FROM 13)::TEXT AS card_id,  -- strip 'card-thread-' (12 chars)
        lg.cp_count
      FROM lg_threads lg
      JOIN pai_intent_card_state s
        ON s.card_id = SUBSTRING(lg.thread_id FROM 13)
      WHERE lg.thread_id LIKE 'card-thread-%'
    )
    SELECT
      user_id,
      thread_id,
      kind,
      card_id,
      NOW() AS last_message_at,
      cp_count AS message_count
    FROM parsed
    WHERE user_id IS NOT NULL
    ON CONFLICT (user_id, thread_id) DO NOTHING;
  END IF;
END$$;
