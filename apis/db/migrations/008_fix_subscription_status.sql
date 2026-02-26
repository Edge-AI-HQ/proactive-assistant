-- Fix subscription status to match all Stripe subscription statuses
-- Add ended_at and stripe_status fields for better tracking

-- First, migrate existing 'pending' status to 'incomplete' (Stripe equivalent)
UPDATE user_subscriptions
SET status = 'incomplete'
WHERE status = 'pending';

-- Drop old constraint
ALTER TABLE user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;

-- Add new constraint with all 8 Stripe statuses
ALTER TABLE user_subscriptions
  ADD CONSTRAINT user_subscriptions_status_check
  CHECK (status IN (
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'paused'
  ));

-- Add ended_at field to track when subscription actually ended
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

-- Add stripe_status to preserve original Stripe status
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_status TEXT;

-- Create index for ended_at queries
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_ended_at
  ON user_subscriptions(ended_at)
  WHERE ended_at IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN user_subscriptions.ended_at IS 'Timestamp when subscription actually ended (from Stripe ended_at field)';
COMMENT ON COLUMN user_subscriptions.stripe_status IS 'Original Stripe subscription status for reference';
COMMENT ON COLUMN user_subscriptions.cancel_at_period_end IS 'If true, subscription will cancel at current_period_end but service continues until then';
