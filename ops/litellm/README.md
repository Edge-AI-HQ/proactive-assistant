# LiteLLM 部署

## 构建与发布

**必须把 `ops/litellm` 作为构建上下文**，否则 Docker 找不到 `litellm_config.yaml`。

- 在仓库根目录执行：
  ```bash
  fly deploy ./ops/litellm -a litellm-dev
  ```
- 或在 `ops/litellm` 目录下执行：
  ```bash
  cd ops/litellm && fly deploy -a litellm-dev
  ```

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

## 常见问题

### 401 Invalid proxy server token

若 apis 调用 LiteLLM 管理接口报 401，说明 **apis 发的是虚拟 key (sk-xxx)，而不是 master key**。

**处理：** 在 apis 的 `LITELLM_MASTER_KEY` 里填的值，必须与 LiteLLM 服务端环境变量 `LITELLM_MASTER_KEY` **完全一致**（即你在 LiteLLM 里配置的管理密钥）。不能填任何由 LiteLLM 生成的虚拟 key（sk- 开头）。

### access_group_ids does not exist / Fly refused connection

**症状：** LiteLLM 启动报 `access_group_ids` 不存在，或 Fly 提示 "not listening on 0.0.0.0:4000"。

**原因：**
1. **`DISABLE_SCHEMA_UPDATE=true` 或 `PRISMA_OFFLINE_MODE=true`**：这些环境变量会**跳过 Prisma 的 schema 迁移**，导致新列（如 `access_group_ids`）未创建。
2. **未监听 0.0.0.0**：Dockerfile 的 CMD 未指定 `--host 0.0.0.0`，LiteLLM 默认监听 `127.0.0.1`，Fly.io 无法访问。

**处理：**
1. **删除或设为 false**：在 Fly secrets 中删掉 `DISABLE_SCHEMA_UPDATE` 和 `PRISMA_OFFLINE_MODE`，或设为 `false`。
   ```bash
   fly secrets unset DISABLE_SCHEMA_UPDATE PRISMA_OFFLINE_MODE -a litellm-dev
   ```
2. **手动补列（若已跳过迁移）**：
   ```sql
   ALTER TABLE litellm."LiteLLM_VerificationToken" 
     ADD COLUMN IF NOT EXISTS "access_group_ids" TEXT[] DEFAULT '{}';
   ```
3. **确保监听 0.0.0.0**：Dockerfile 的 CMD 里加 `--host 0.0.0.0`（已在本仓库 Dockerfile 中修复）。
