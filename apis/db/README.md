# API DB Migrations

This folder contains the canonical database migrations for the unified API server.

Fresh database:
1. `001_unified_schema.sql`
2. `002_litellm_identity_unification.sql`
3. `003_user_litellm_shared_key.sql`
4. `004_drop_admin_schema.sql`
5. `007_payment_event_ordering.sql`
6. `008_remove_wallet_ledger_tables.sql`
7. `009_drop_user_assistant_bot_columns.sql`

Legacy database upgrade (existing `users`/`assistants` tables):
1. `001_unified_schema.sql`
2. `005_add_missing_litellm_columns.sql`
3. `002_litellm_identity_unification.sql`
4. `003_user_litellm_shared_key.sql`
5. `004_drop_admin_schema.sql`
6. `007_payment_event_ordering.sql`
7. `008_remove_wallet_ledger_tables.sql`
8. `009_drop_user_assistant_bot_columns.sql`

订阅周期表（在已有库上执行一次即可建表）：
- `012_subscription_periods.sql` — 创建 `subscription_periods` 表（Stripe 计费周期 + 定时任务应用 LiteLLM budget）

执行方式：用你的数据库客户端或 `psql` 连接 `SUPABASE_DB_URL` 对应的库，按顺序执行上述 SQL 文件内容。新建库按 Fresh 顺序跑；已有库按 Legacy 顺序跑，最后再执行 `012_subscription_periods.sql`。
