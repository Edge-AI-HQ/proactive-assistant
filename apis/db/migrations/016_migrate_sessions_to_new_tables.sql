-- 在已有 user_sessions 的数据库上迁移到新的表结构
-- 这是用于从旧版 001 升级到新版 001 的迁移脚本

-- 1. 创建 gateway_sessions 表
CREATE TABLE IF NOT EXISTS gateway_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL,
  telegram_username_snapshot TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateway_sessions_user_id ON gateway_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_gateway_sessions_assistant_id ON gateway_sessions(assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expires_at ON gateway_sessions(expires_at);

-- 2. 创建 payment_sessions 表
CREATE TABLE IF NOT EXISTS payment_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE SET NULL,
  session_token TEXT UNIQUE NOT NULL,
  plan_code TEXT,
  telegram_username_snapshot TEXT,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_user_id ON payment_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_assistant_id ON payment_sessions(assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_sessions_expires_at ON payment_sessions(expires_at);

-- 3. 迁移数据（如果 user_sessions 表存在）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'user_sessions') THEN
    -- 迁移 gateway sessions
    INSERT INTO gateway_sessions (user_id, session_token, telegram_username_snapshot, expires_at, created_at)
    SELECT user_id, session_token, telegram_username_snapshot, expires_at, created_at
    FROM user_sessions
    WHERE session_type = 'gateway'
    ON CONFLICT (session_token) DO NOTHING;
    
    -- 迁移 payment sessions
    INSERT INTO payment_sessions (user_id, session_token, telegram_username_snapshot, used, expires_at, used_at, created_at)
    SELECT user_id, session_token, telegram_username_snapshot, used, expires_at, used_at, created_at
    FROM user_sessions
    WHERE session_type = 'payment'
    ON CONFLICT (session_token) DO NOTHING;
    
    -- 删除旧表
    DROP TABLE user_sessions CASCADE;
    
    RAISE NOTICE 'Migrated user_sessions to gateway_sessions and payment_sessions';
  ELSE
    RAISE NOTICE 'user_sessions table does not exist, skipping migration';
  END IF;
END $$;

-- 4. 添加注释
COMMENT ON TABLE gateway_sessions IS '用户访问助理 gateway 的认证会话';
COMMENT ON COLUMN gateway_sessions.assistant_id IS '关联的助理 ID；NULL=用户级 session，非空=助理级 session';
COMMENT ON TABLE payment_sessions IS '支付流程的一次性 token';
COMMENT ON COLUMN payment_sessions.assistant_id IS '关联的助理 ID（可选）；未来支持为特定助理购买订阅';

-- 5. 启用 RLS
ALTER TABLE gateway_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;
