-- Support Google/Microsoft/etc OAuth login via Supabase Auth.
-- Maps Supabase auth.users UUID → legacy users.id BIGSERIAL.
-- Telegram-only fields become nullable so OAuth-only users can exist.

BEGIN;

-- 1. Add Supabase auth.users mapping + profile fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id UUID UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT; -- 'google', 'microsoft', 'telegram', etc.

-- 2. Make telegram_user_id optional (OAuth users won't have one)
ALTER TABLE users ALTER COLUMN telegram_user_id DROP NOT NULL;

-- 3. Relax CHECK to allow NULL telegram_user_id
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_user_id_check;
ALTER TABLE users ADD CONSTRAINT users_telegram_user_id_check
  CHECK (telegram_user_id IS NULL OR telegram_user_id > 0);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_auth_provider ON users(auth_provider) WHERE auth_provider IS NOT NULL;

COMMIT;
