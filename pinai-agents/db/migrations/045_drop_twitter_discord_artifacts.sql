-- Drop discord + twitter from the live connector set.
--
-- Background:
--   * discord recipe was always connect_only (no raw table); dropped per
--     migration 036 already.
--   * twitter recipe was recipe-only (no upserter ever wired up). After
--     Composio stopped hosting Twitter shared OAuth in Feb 2026 the
--     toolkit became unusable for tenants without their own OAuth app,
--     and the product surface dropped it.
--
-- Cleanup scope:
--   * Drop pai_raw_twitter_bookmarks (orphan table — never had an
--     upserter; safe data loss).
--   * Cancel any in-flight scheduler rows referencing the two toolkits.
--   * Purge sync cursors and label rows so a future Composio
--     re-introduction starts from a clean slate.
--
-- pai_raw_discord_guilds was already dropped in 036.

DROP TABLE IF EXISTS pai_raw_twitter_bookmarks;

DELETE FROM pai_scheduled_tasks
WHERE kind IN ('connector.init', 'connector.sync', 'connector.evolve')
  AND payload->>'toolkit' IN ('discord', 'twitter');

DELETE FROM pai_connector_sync_cursors
WHERE toolkit IN ('discord', 'twitter');

DELETE FROM pai_connector_labels
WHERE toolkit IN ('discord', 'twitter');
