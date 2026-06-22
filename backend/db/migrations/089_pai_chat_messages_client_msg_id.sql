-- client_msg_id: the client-generated message id (FE crypto.randomUUID) a
-- user turn was sent with. Carried as pai_agent_messages.idempotency_key
-- through the mailbox, then stamped onto the persisted history row here so
-- the frontend can reconcile its optimistic bubble against BOTH the
-- in-flight view (/history `active.userEntries`) and the finalized row by
-- identity instead of by text (same text ≠ same message). NULL for
-- assistant/heartbeat rows, pre-089 rows, checkpoint backfills, and sends
-- from clients that don't supply one. Read back whole-row only — no index.
ALTER TABLE pai_chat_messages ADD COLUMN client_msg_id TEXT;
