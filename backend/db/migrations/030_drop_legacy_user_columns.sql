-- Drop legacy `container_proxy_secret` from users.
--
-- Inherited from the apis schema baseline (per-user OpenClaw container
-- proxy auth). backend has no per-user container — every user shares
-- the multi-tenant chat / web processes — so the column is dead weight.
-- Carrying it forward forces user_service to invent a synthetic UUID on
-- every INSERT just to satisfy NOT NULL, which is purely ceremonial.
--
-- Pre-launch product, no users, no migration ceremony needed: drop
-- directly. apis Node code is being sunset and won't run against this
-- schema once the cutover lands.

ALTER TABLE users DROP COLUMN IF EXISTS container_proxy_secret;
