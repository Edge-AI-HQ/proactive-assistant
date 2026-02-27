-- 同步 LiteLLM Prisma schema 到数据库
-- 在 litellm schema 下执行

-- 添加缺失的列
ALTER TABLE litellm."LiteLLM_DeletedTeamTable" 
  ADD COLUMN IF NOT EXISTS "access_group_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE litellm."LiteLLM_DeletedVerificationToken" 
  ADD COLUMN IF NOT EXISTS "access_group_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE litellm."LiteLLM_GuardrailsTable" 
  ADD COLUMN IF NOT EXISTS "team_id" TEXT;

ALTER TABLE litellm."LiteLLM_PolicyTable" 
  ADD COLUMN IF NOT EXISTS "pipeline" JSONB;

ALTER TABLE litellm."LiteLLM_TeamTable" 
  ADD COLUMN IF NOT EXISTS "access_group_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- 创建缺失的表
CREATE TABLE IF NOT EXISTS litellm."LiteLLM_ManagedVectorStoreTable" (
  "id" TEXT NOT NULL,
  "unified_resource_id" TEXT NOT NULL,
  "resource_object" JSONB,
  "model_mappings" JSONB NOT NULL,
  "flat_model_resource_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "storage_backend" TEXT,
  "storage_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "updated_by" TEXT,
  CONSTRAINT "LiteLLM_ManagedVectorStoreTable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS litellm."LiteLLM_AccessGroupTable" (
  "access_group_id" TEXT NOT NULL,
  "access_group_name" TEXT NOT NULL,
  "description" TEXT,
  "access_model_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "access_mcp_server_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "access_agent_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "assigned_team_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "assigned_key_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" TEXT,
  CONSTRAINT "LiteLLM_AccessGroupTable_pkey" PRIMARY KEY ("access_group_id")
);

-- 创建索引
CREATE UNIQUE INDEX IF NOT EXISTS "LiteLLM_ManagedVectorStoreTable_unified_resource_id_key" 
  ON litellm."LiteLLM_ManagedVectorStoreTable"("unified_resource_id");

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedVectorStoreTable_unified_resource_id_idx" 
  ON litellm."LiteLLM_ManagedVectorStoreTable"("unified_resource_id");

CREATE UNIQUE INDEX IF NOT EXISTS "LiteLLM_AccessGroupTable_access_group_name_key" 
  ON litellm."LiteLLM_AccessGroupTable"("access_group_name");
