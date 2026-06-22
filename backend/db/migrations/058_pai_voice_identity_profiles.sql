-- User-owned self voice reference metadata for ambient diarization.
-- Audio bytes live in Supabase Storage under {supabase_user_id}/voice_identity/.

CREATE TABLE pai_voice_identity_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  speaker_name TEXT NOT NULL DEFAULT 'self',
  reference_storage_path TEXT NOT NULL,
  reference_mime TEXT NOT NULL DEFAULT 'audio/wav',
  reference_byte_len INTEGER NOT NULL,
  reference_duration_ms INTEGER NOT NULL,
  reference_sha256 TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (speaker_name = 'self'),
  CHECK (reference_duration_ms BETWEEN 2000 AND 10000),
  CHECK (reference_byte_len > 0)
);

ALTER TABLE pai_voice_identity_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_voice_identity_profiles_user_scope ON pai_voice_identity_profiles
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_voice_identity_profiles_service_role ON pai_voice_identity_profiles
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
