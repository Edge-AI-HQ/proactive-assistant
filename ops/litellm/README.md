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

### Prisma 迁移超时 / Fly refused connection

**症状：** 部署时日志显示 "Running prisma migrate deploy" 后卡住，Fly 报错 "instance refused connection. is your app listening on 0.0.0.0:4000?"

**原因：**
1. **Prisma 迁移耗时过长**：数据库连接慢、迁移任务多、或内存不足导致迁移超时
2. **健康检查超时**：Fly 默认健康检查超时较短，Prisma 迁移未完成前服务无法响应

**处理方案（按优先级）：**

**1. 增加内存和超时配置**（推荐）：
   - `fly.toml` 中已配置 4GB 内存和 60s grace period
   - 如果还超时，可临时提升到 8GB：
     ```bash
     fly scale memory 8192 -a litellm-dev
     ```

**2. 跳过自动迁移**（适合数据库已初始化的情况）：
   ```bash
   fly secrets set DISABLE_SCHEMA_UPDATE=true -a litellm-dev
   ```
   ⚠️ 使用此选项前，确保数据库 schema 已是最新版本，否则会缺少必需的表/列

**3. 手动执行迁移**（一次性操作）：
   ```bash
   # 在本地连接生产数据库执行迁移
   DATABASE_URL="your-production-db-url" npx prisma migrate deploy
   ```
   然后设置 `DISABLE_SCHEMA_UPDATE=true` 跳过后续自动迁移

**4. 检查数据库连接串**：
   确保 `DATABASE_URL` 末尾包含 `?options=-c%20search_path%3Dlitellm`，避免操作错误的 schema

### access_group_ids does not exist

**症状：** LiteLLM 启动报 `access_group_ids` 列不存在

**原因：** 设置了 `DISABLE_SCHEMA_UPDATE=true` 或 `PRISMA_OFFLINE_MODE=true` 跳过了迁移

**处理：**
1. 删除这些环境变量让 Prisma 自动迁移：
   ```bash
   fly secrets unset DISABLE_SCHEMA_UPDATE PRISMA_OFFLINE_MODE -a litellm-dev
   ```
2. 或手动补列：
   ```sql
   ALTER TABLE litellm."LiteLLM_VerificationToken" 
     ADD COLUMN IF NOT EXISTS "access_group_ids" TEXT[] DEFAULT '{}';
   ```
