-- 删除 litellm schema 中的所有表，让 LiteLLM 重新迁移
SET search_path TO litellm;

DROP TABLE IF EXISTS "LiteLLM_ManagedVectorStoreTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_AccessGroupTable" CASCADE;
DROP TABLE IF EXISTS "_prisma_migrations" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_VerificationToken" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_TeamTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_DeletedTeamTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_DeletedVerificationToken" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_GuardrailsTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_PolicyTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_UserTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_BudgetTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_ModelTable" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_SpendLogs" CASCADE;
DROP TABLE IF EXISTS "LiteLLM_Config" CASCADE;

-- 确认已清空
SELECT tablename FROM pg_tables WHERE schemaname = 'litellm';
