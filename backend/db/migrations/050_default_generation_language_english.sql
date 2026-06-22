-- New users default to English output until they choose another language in
-- Control Panel. Existing user selections are preserved.
ALTER TABLE pai_user_settings
  ALTER COLUMN generation_language SET DEFAULT 'en';
