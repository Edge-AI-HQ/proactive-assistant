-- 用户待处理动作表（替代内存状态，支持集群部署）

CREATE TABLE IF NOT EXISTS user_pending_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('token_input')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE (user_id, action_type)
);

CREATE INDEX IF NOT EXISTS idx_user_pending_actions_expires_at 
  ON user_pending_actions(expires_at);

COMMENT ON TABLE user_pending_actions IS '用户待处理动作（集群部署下的状态共享）';
COMMENT ON COLUMN user_pending_actions.action_type IS '动作类型：token_input=等待用户输入 bot token';
