-- pai_skill_index: add inline `body` column for skill markdown.
--
-- Plan v2 § Step 2b earmarks moving body to Supabase Storage. Until
-- then, inline TEXT keeps the schema simple. Body sizes are typically
-- 1-50 KB per skill — fine for Postgres.

ALTER TABLE pai_skill_index ADD COLUMN IF NOT EXISTS body TEXT;
