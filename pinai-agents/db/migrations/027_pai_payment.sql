-- Stripe billing — minimum viable subscription surface.
-- Three tables collapsed from apis's seven (billing_plans / subscription_periods /
-- subscription_event_watermarks / payment_events / etc.). We don't need
-- per-period history for the MVP — current state on the subscription row is
-- enough for "does this user have access?" gating.
--
-- 1. pai_billing_plans     — catalog (plan_code, stripe_price_id, display).
-- 2. pai_subscriptions     — one row per user holding current sub state.
-- 3. pai_stripe_webhook_events — idempotency log for webhook handlers.

-- ── Plans catalog ──
CREATE TABLE pai_billing_plans (
  plan_code              TEXT PRIMARY KEY
                         CHECK (plan_code IN ('basic', 'pro', 'max')),
  display_name           TEXT NOT NULL,
  stripe_price_id        TEXT UNIQUE NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'usd',
  price_cents_monthly    INTEGER NOT NULL CHECK (price_cents_monthly >= 0),
  monthly_refresh_credits INTEGER NOT NULL DEFAULT 0
                         CHECK (monthly_refresh_credits >= 0),
  sort_order             INTEGER NOT NULL DEFAULT 0,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pai_billing_plans_active_order
  ON pai_billing_plans (is_active, sort_order);

-- Seed the same three plans as apis. Stripe price IDs are PROD ids — set
-- env vars BILLING_PRICE_ID_BASIC etc. to override at test time. Same as
-- apis baseline.
INSERT INTO pai_billing_plans
  (plan_code, display_name, stripe_price_id, currency,
   price_cents_monthly, monthly_refresh_credits, sort_order, is_active)
VALUES
  ('basic', 'Basic', 'price_1T50rb2K5fzHJAlc2maOE5fP', 'usd', 3900,  3200, 10, TRUE),
  ('pro',   'Pro',   'price_1T50rc2K5fzHJAlcTYU5PxtX', 'usd', 9900, 12800, 20, TRUE),
  ('max',   'Max',   'price_1T50rd2K5fzHJAlc4WmBNvPy', 'usd', 19900, 28800, 30, TRUE)
ON CONFLICT (plan_code) DO NOTHING;

-- ── Subscriptions (current state per user) ──
CREATE TABLE pai_subscriptions (
  user_id                BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  plan_code              TEXT REFERENCES pai_billing_plans(plan_code),
  status                 TEXT NOT NULL DEFAULT 'inactive'
                         CHECK (status IN
                                ('inactive', 'trialing', 'active',
                                 'past_due', 'canceled', 'incomplete')),
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pai_subscriptions_stripe_sub
  ON pai_subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX idx_pai_subscriptions_stripe_customer
  ON pai_subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── Webhook event idempotency log ──
-- Every Stripe webhook delivery is recorded here keyed by event_id. The
-- (status='processed') row blocks re-processing on retry. claim_status
-- transitions: claimed → processed | failed.
CREATE TABLE pai_stripe_webhook_events (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'claimed'
                  CHECK (status IN ('claimed', 'processed', 'failed', 'skipped')),
  error_message   TEXT,
  raw_data        JSONB,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

CREATE INDEX idx_pai_stripe_webhook_events_type_claimed
  ON pai_stripe_webhook_events (event_type, claimed_at DESC);

-- ── User table additions ──
-- stripe_customer_id lets us reuse a single Stripe customer across
-- multiple checkouts for the same user (no duplicate customers).
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

-- ── RLS ──
-- pai_subscriptions: per-user. pai_billing_plans: public read, service-role
-- write (catalog edits go through migrations). pai_stripe_webhook_events:
-- service-role only (webhook handler runs as service_role; users never
-- read this table).

ALTER TABLE pai_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_subscriptions_user_scope ON pai_subscriptions
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_subscriptions_service_role ON pai_subscriptions
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

ALTER TABLE pai_billing_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_billing_plans_public_read ON pai_billing_plans
  FOR SELECT TO PUBLIC USING (TRUE);
CREATE POLICY pai_billing_plans_service_write ON pai_billing_plans
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE pai_stripe_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_stripe_webhook_events_service_only ON pai_stripe_webhook_events
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
