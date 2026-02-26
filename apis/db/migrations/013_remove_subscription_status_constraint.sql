-- 移除订阅状态的约束，允许 Stripe 的所有 8 种状态
-- Stripe 状态: incomplete, incomplete_expired, trialing, active, past_due, canceled, unpaid, paused
ALTER TABLE user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;
