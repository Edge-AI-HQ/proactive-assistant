CREATE TABLE IF NOT EXISTS google_oauth_states (
  state_token TEXT PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  next_path TEXT NOT NULL DEFAULT '/mini',
  code_verifier TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_states_expires_at
  ON google_oauth_states (expires_at DESC);

CREATE TABLE IF NOT EXISTS google_oauth_credentials (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  id_token_enc TEXT,
  token_type TEXT,
  scope TEXT,
  expiry_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_credentials_telegram_user_id
  ON google_oauth_credentials (telegram_user_id);

COMMENT ON TABLE google_oauth_states IS 'Ephemeral state for Google OAuth browser redirects.';
COMMENT ON TABLE google_oauth_credentials IS 'Per-user Google OAuth tokens encrypted at application layer.';
