-- Rename legacy plaintext key column to a neutral name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'litellm_virtual_key_encrypted'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'litellm_virtual_key'
  ) THEN
    ALTER TABLE users RENAME COLUMN litellm_virtual_key_encrypted TO litellm_virtual_key;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'assistants'
      AND column_name = 'litellm_virtual_key_encrypted'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'assistants'
      AND column_name = 'litellm_virtual_key'
  ) THEN
    ALTER TABLE assistants RENAME COLUMN litellm_virtual_key_encrypted TO litellm_virtual_key;
  END IF;
END $$;
