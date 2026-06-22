-- users.browserbase_context_id — per-user persistent Browserbase context.
--
-- Ties cookies / login state to one user across Browserbase sessions so
-- the agent doesn't have to re-login every chat. Lazy-provisioned by
-- web/services/browserbase_provisioning.py on first chat-stream/send
-- when BROWSERBASE_API_KEY is configured; nullable so deploys without
-- Browserbase keep working.
ALTER TABLE users ADD COLUMN IF NOT EXISTS browserbase_context_id TEXT;
