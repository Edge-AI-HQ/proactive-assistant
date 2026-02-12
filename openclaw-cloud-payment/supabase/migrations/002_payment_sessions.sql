-- 支付会话表（一次性 token）
CREATE TABLE payment_sessions (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL,
  telegram_username TEXT,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_payment_token ON payment_sessions(token);
CREATE INDEX idx_payment_expires ON payment_sessions(expires_at);
CREATE INDEX idx_payment_used ON payment_sessions(used);

-- 启用 RLS
ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;

-- 允许服务端角色访问所有数据
CREATE POLICY "Service role can do everything" ON payment_sessions
  FOR ALL USING (auth.role() = 'service_role');
