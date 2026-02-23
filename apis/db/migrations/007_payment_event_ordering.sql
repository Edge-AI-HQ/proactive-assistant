ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT,
  ADD COLUMN IF NOT EXISTS last_stripe_event_id TEXT;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_last_stripe_event
  ON user_subscriptions(last_stripe_event_created, last_stripe_event_id);
