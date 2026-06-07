-- pai_chat_messages.trigger — how an assistant turn was triggered.
--
-- proactive reuses pai_chat_messages (one row per user-visible turn, O(page)
-- cursor pagination) instead of reconstructing checkpoint state via aget_state
-- on every history read — the same decoupling main chat got in 079. A proactive
-- assistant turn can be triggered by a heartbeat tick (the ~30s ambient input)
-- rather than a user message; the frontend marks tick-triggered turns as
-- debug-only (visible only when they carry a notify_user). `trigger` carries
-- that classification through the table so reload matches the live view.
--
-- Default 'user' keeps every existing row and ALL main-chat turns unaffected
-- (main chat is always user-triggered). Silent ticks are NOT persisted here
-- (their negative-sample record lives in pai_proactive_events), so the table
-- only ever holds 'user' turns + tick-triggered assistant turns that actually
-- reached out — it does not grow with the heartbeat.

ALTER TABLE pai_chat_messages
  ADD COLUMN trigger TEXT NOT NULL DEFAULT 'user'
  CHECK (trigger IN ('user', 'tick'));
