-- Add observability columns to proactive_browser_context.
--
-- last_used_at:  bumped on every getOrCreateBrowserContext hit. Lets us
--                build a future housekeeping job that recycles contexts
--                unused past some threshold (Browserbase contexts live
--                forever on their side until explicitly deleted).
-- updated_at:    lifecycle timestamp distinct from created_at; useful
--                when we extend this table (e.g. marking a context as
--                invalidated before recreating).

ALTER TABLE proactive_browser_context
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
