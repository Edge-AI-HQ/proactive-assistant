-- 用户订阅表
CREATE TABLE user_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  docker_container_id TEXT,
  docker_port INTEGER,
  docker_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'paused', 'canceled', 'pending')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_stripe_customer ON user_subscriptions(stripe_customer_id);
CREATE INDEX idx_stripe_subscription ON user_subscriptions(stripe_subscription_id);
CREATE INDEX idx_status ON user_subscriptions(status);

-- 支付事件日志
CREATE TABLE payment_events (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_payment_telegram_user ON payment_events(telegram_user_id);
CREATE INDEX idx_payment_event_type ON payment_events(event_type);
CREATE INDEX idx_payment_created_at ON payment_events(created_at DESC);

-- Docker 容器日志
CREATE TABLE container_logs (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'started', 'stopped', 'removed', 'error')),
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_container_telegram_user ON container_logs(telegram_user_id);
CREATE INDEX idx_container_id ON container_logs(container_id);
CREATE INDEX idx_container_action ON container_logs(action);

-- 自动更新 updated_at 触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_subscriptions_updated_at
  BEFORE UPDATE ON user_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS (Row Level Security) 策略
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE container_logs ENABLE ROW LEVEL SECURITY;

-- 允许服务端角色访问所有数据
CREATE POLICY "Service role can do everything" ON user_subscriptions
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can do everything" ON payment_events
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can do everything" ON container_logs
  FOR ALL USING (auth.role() = 'service_role');
