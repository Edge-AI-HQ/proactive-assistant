-- 添加订阅同步所需的字段
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS stripe_status TEXT,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP WITH TIME ZONE;

-- 确保事件跟踪字段存在（来自 007 迁移）
ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS last_stripe_event_created BIGINT,
  ADD COLUMN IF NOT EXISTS last_stripe_event_id TEXT;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_last_stripe_event
  ON user_subscriptions(last_stripe_event_created, last_stripe_event_id);
