-- 修复订阅同步所需的数据库字段和约束
-- 1. 添加订阅同步所需的字段
-- 2. 移除状态约束以支持所有 Stripe 状态

-- 添加 Stripe 原始状态字段和结束时间字段
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_status TEXT,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP WITH TIME ZONE;

-- 添加事件跟踪字段，用于防止过期事件覆盖新状态
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT,
  ADD COLUMN IF NOT EXISTS last_stripe_event_id TEXT;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_last_stripe_event
  ON user_subscriptions(last_stripe_event_created, last_stripe_event_id);

-- 移除订阅状态的约束，允许 Stripe 的所有 8 种状态
-- Stripe 状态: incomplete, incomplete_expired, trialing, active, past_due, canceled, unpaid, paused
-- 之前只允许: active, paused, canceled, pending
ALTER TABLE user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;
