CREATE TABLE IF NOT EXISTS stripe_subscription_event_watermarks (
  stripe_subscription_id TEXT PRIMARY KEY,
  last_event_created BIGINT NOT NULL,
  last_event_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_event_watermarks_updated_at
  ON stripe_subscription_event_watermarks (updated_at DESC);

COMMENT ON TABLE stripe_subscription_event_watermarks IS 'Monotonic watermark per Stripe subscription to ignore out-of-order webhook events.';
