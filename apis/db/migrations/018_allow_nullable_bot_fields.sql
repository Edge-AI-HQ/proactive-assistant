-- 允许 assistant 不绑定具体的 bot（Quick Start 模式）
-- 移除 NOT NULL 和 UNIQUE 约束，允许多个用户使用 Quick Start 模式

-- 1. 移除 NOT NULL 约束，允许这些字段为 NULL
ALTER TABLE assistants ALTER COLUMN assistant_bot_id DROP NOT NULL;
ALTER TABLE assistants ALTER COLUMN assistant_bot_token DROP NOT NULL;
ALTER TABLE assistants ALTER COLUMN assistant_bot_username DROP NOT NULL;

-- 2. 删除 UNIQUE 约束
ALTER TABLE assistants DROP CONSTRAINT IF EXISTS assistants_assistant_bot_id_key;
ALTER TABLE assistants DROP CONSTRAINT IF EXISTS assistants_assistant_bot_token_key;
ALTER TABLE assistants DROP CONSTRAINT IF EXISTS assistants_assistant_bot_username_key;

-- 3. 添加复合 UNIQUE 约束：如果用户绑定了 bot，同一个 bot 不能被同一个用户绑定多次
-- 但允许：
--   - 多个用户都是 NULL（Quick Start 模式）
--   - 不同用户使用不同的 bot
ALTER TABLE assistants ADD CONSTRAINT assistants_owner_bot_unique 
  UNIQUE NULLS NOT DISTINCT (owner_user_id, assistant_bot_id);

-- 4. 添加索引以优化查询
CREATE INDEX IF NOT EXISTS idx_assistants_bot_id ON assistants(assistant_bot_id) WHERE assistant_bot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assistants_bot_token ON assistants(assistant_bot_token) WHERE assistant_bot_token IS NOT NULL;

-- 说明：
-- - Quick Start 模式：assistant_bot_id/token/username 都是 NULL
-- - Advanced 模式：用户提供自己的 bot token，这些字段有值
-- - Router 通过 telegram_user_id 路由，不依赖 bot_id
