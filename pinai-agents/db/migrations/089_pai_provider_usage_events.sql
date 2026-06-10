-- Provider usage ledger for direct provider calls that do not flow through
-- LiteLLM, e.g. ByteDance streaming ASR and future ByteDance file ASR.

CREATE TABLE pai_provider_usage_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supabase_user_id    UUID NOT NULL,
  provider            TEXT NOT NULL,
  product             TEXT NOT NULL,
  source              TEXT NOT NULL,
  units               TEXT NOT NULL DEFAULT 'seconds',
  quantity_seconds    NUMERIC(12, 3) NOT NULL DEFAULT 0,
  cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'USD',
  status              TEXT NOT NULL DEFAULT 'succeeded',
  provider_request_id TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (provider <> ''),
  CHECK (product <> ''),
  CHECK (source <> ''),
  CHECK (units = 'seconds'),
  CHECK (quantity_seconds >= 0),
  CHECK (cost_usd >= 0),
  CHECK (currency = 'USD'),
  CHECK (status IN ('succeeded', 'failed'))
);

CREATE INDEX idx_pai_provider_usage_events_user_created
  ON pai_provider_usage_events (user_id, created_at DESC);

CREATE INDEX idx_pai_provider_usage_events_provider_product
  ON pai_provider_usage_events (provider, product, created_at DESC);

ALTER TABLE pai_provider_usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_provider_usage_events_user_scope ON pai_provider_usage_events
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_provider_usage_events_service_role ON pai_provider_usage_events
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
