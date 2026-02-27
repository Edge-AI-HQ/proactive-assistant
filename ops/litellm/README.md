# LiteLLM 部署

## 与 apis 共用同一库（推荐）

LiteLLM 启动时 Prisma 会同步 schema，若连到默认的 `public` schema 会**删掉库里不在其 schema 的表**（包括 apis 的 `users`、`assistants` 等）。所以共用一库时要用 **PostgreSQL schema 隔离**，让 LiteLLM 只用自己的 schema。

### 步骤（一次性）

1. **在库里建 schema**（与 apis 同库执行一次即可）：
   ```sql
   CREATE SCHEMA IF NOT EXISTS litellm;
   ```

2. **LiteLLM 的 `DATABASE_URL`** 用同一库连接串，并在**末尾**加上（注意保留原有 `?`/`&`）：
   ```
   ?options=-c%20search_path%3Dlitellm
   ```
   若连接串已有参数，用 `&` 接：`...?foo=bar&options=-c%20search_path%3Dlitellm`

这样 LiteLLM 的表和 `_prisma_migrations` 都会建在 `litellm` schema，不会动 `public` 下的业务表。

### 用独立库

若不想共用库，可新建一个库（如 Supabase 再建一个 project），`DATABASE_URL` 直接填该库连接串，无需加 `options`。
