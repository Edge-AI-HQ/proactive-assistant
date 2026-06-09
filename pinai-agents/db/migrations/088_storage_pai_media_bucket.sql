-- Provision the pai-media Storage bucket via migration.
--
-- Supabase keeps bucket metadata in storage.buckets, which lives in the
-- same Postgres our DATABASE_URL connects to (db.<ref>.supabase.co), so
-- yoyo provisions the bucket next to the pai_* schema instead of a manual
-- dashboard step. Prod missed that step and every ambient / voice upload
-- 500'd ("Bucket not found") until the bucket was created by hand.
--
-- We read/write storage exclusively with the service_role key, which
-- bypasses RLS (web/storage.py), and the frontend never hits storage
-- directly -- so the bucket row alone suffices, no storage.objects policy.
--
-- The storage schema only exists on Supabase; local dev and CI run a bare
-- pgvector/pgvector:pg15 Postgres without it. Guard on the schema and
-- no-op there. Idempotent on Supabase as well (ON CONFLICT DO NOTHING),
-- so the hand-created dev/prod buckets are left untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage'
  ) THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('pai-media', 'pai-media', FALSE)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
