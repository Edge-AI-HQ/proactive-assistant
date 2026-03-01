-- 添加 assistant_id 到订阅相关表，支持未来每个助理独立订阅

-- 1. subscription_periods 添加 assistant_id
ALTER TABLE subscription_periods
  ADD COLUMN IF NOT EXISTS assistant_id BIGINT REFERENCES assistants(id) ON DELETE CASCADE;

-- 索引：按助理查询订阅
CREATE INDEX IF NOT EXISTS idx_subscription_periods_assistant_id
  ON subscription_periods (assistant_id)
  WHERE assistant_id IS NOT NULL;

COMMENT ON COLUMN subscription_periods.assistant_id IS '关联的助理 ID（可选）；支持未来每个助理独立订阅；当前为 NULL 表示用户级订阅';

-- 2. payment_events 添加 assistant_id（可选，用于追踪）
ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS assistant_id BIGINT REFERENCES assistants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_events_assistant_id
  ON payment_events (assistant_id)
  WHERE assistant_id IS NOT NULL;

COMMENT ON COLUMN payment_events.assistant_id IS '关联的助理 ID（可选）；用于追踪事件属于哪个助理的订阅';

-- 注意：当前实现为用户级订阅，assistant_id 为 NULL
-- 未来支持助理级订阅时，可以在 checkout 时指定 assistant_id
