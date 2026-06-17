-- Per-user "permission mode" for the chat agent's side-effect tools — selects
-- how the HITL approval gate behaves before COMPOSIO_MULTI_EXECUTE_TOOL
-- (outbound SaaS actions) + preference_add:
--   'ask'    — default; pause for human approval (HumanInTheLoopMiddleware).
--   'bypass' — run side-effect tools without the per-call approval pause.
-- TEXT + CHECK (not bool) so future modes can be added by a follow-up
-- migration that widens the CHECK — no structural change. Default 'ask' keeps
-- the approval gate for every existing + new user. This column is the
-- persisted, cross-device SSOT for the composer's mode menu; the runtime
-- effect is delivered per-run through the request meta (mapped to a bool),
-- never read from this column by the chat process (trust boundary).
ALTER TABLE pai_user_settings
  ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'
  CHECK (permission_mode IN ('ask', 'bypass'));
