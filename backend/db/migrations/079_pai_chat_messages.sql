-- pai_chat_messages — append-only conversation log, the SSOT for chat
-- history *display*.
--
-- Why a separate table from langgraph.checkpoints:
--   The checkpoint store (langgraph-checkpoint-postgres) holds the agent's
--   running state. Its `messages` channel uses an add_messages reducer that
--   snapshots the FULL accumulated list at every super-step — O(N^2) blob
--   growth on long threads — and reading a thread's history means
--   reconstructing the whole compiled-graph state via aget_state() (seconds
--   on a long thread). That couples "history display" to "agent state".
--
--   This table decouples them (the Claude/ChatGPT/Manus convention): one row
--   per conversation turn, written at the web SSE boundary, read back with
--   O(page) cursor pagination — independent of how the agent stores state.
--   The agent's working context is bounded separately (RemoveMessage trim);
--   long-term recall is the existing pai_memory system. History never lives
--   in the agent's context window, so trimming it loses nothing here.
--
-- `parts` stores the exact shape chat/routes/history.py:_build_history emits
-- (and the frontend's HistoryMessage already consumes): a JSON array of
-- {type: text|reasoning|tool-call, ...}. One row = one user or assistant turn.
--
-- `id` is a global IDENTITY (not a per-thread seq): monotonic, so it doubles
-- as the pagination cursor with no MAX(seq)+1 race on concurrent appends.
-- Ordering within a thread is by `id` (insertion order == conversation order).

CREATE TABLE pai_chat_messages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  parts       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Covers both access paths: newest-first page for a thread, and
-- latest-id / tail-delete. (user_id, thread_id) prefix keeps it RLS-aligned.
CREATE INDEX idx_pai_chat_messages_thread
  ON pai_chat_messages (user_id, thread_id, id DESC);

-- RLS — same per-user pattern as 023_pai_rls.sql (main scope + service_role
-- fallback for ops / migrations / scheduler).
ALTER TABLE pai_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_chat_messages_user_scope ON pai_chat_messages
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_chat_messages_service_role ON pai_chat_messages
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
