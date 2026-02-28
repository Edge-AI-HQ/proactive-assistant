# LiteLLM 部署

测试自动部署触发 v2。

## 性能和扩展

### 当前架构
- **单进程模式**：每个 VM 运行单个 LiteLLM 进程
- **水平扩展**：通过 Fly.io 自动扩展多个 VM 实例
- **异步处理**：基于 Uvicorn/asyncio，单进程也能处理大量并发

### 吞吐量配置
```toml
min_machines_running = 1        # 至少保持 1 个实例运行
concurrency.soft_limit = 100    # 单个 VM 处理 100 个并发请求后启动新实例
concurrency.hard_limit = 200    # 单个 VM 最多处理 200 个并发请求
```

### 为什么不用多进程（num_workers）
- Worker 子进程启动后立即崩溃（可能是 Prisma 或数据库连接问题）
- 单进程 + 多 VM 更稳定可靠
- 异步 I/O 模型对 LLM API 调用（I/O 密集型）足够高效

### 监控和调优
```bash
# 查看当前负载
fly status -a litellm-dev

# 查看实时日志
fly logs -a litellm-dev

# 手动扩展（如果需要）
fly scale count 3 -a litellm-dev

# 查看请求延迟
fly metrics -a litellm-dev
```

### 何时需要优化
如果出现以下情况，考虑增加资源：
1. **请求排队时间 > 1秒** - 增加 VM 数量
2. **CPU 使用率 > 80%** - 增加 CPU 核心数
3. **内存使用率 > 80%** - 增加内存配置

## 版本管理

**重要：** Dockerfile 使用固定版本标签（如 `v1.81.12-stable`）而不是滚动标签（如 `main-stable`），以避免自动更新导致数据库 schema 不一致。

### 更新 LiteLLM 版本

1. **修改 Dockerfile 版本号**：
   ```dockerfile
   FROM docker.litellm.ai/berriai/litellm:v1.81.12-stable
   ```

2. **同步数据库 schema**：
   ```bash
   # 在 Supabase SQL Editor 中执行 sync-schema.sql
   # 或使用 psql：
   psql "postgresql://postgres:PASSWORD@HOST:5432/postgres?options=-c%20search_path%3Dlitellm" \
     -f ops/litellm/sync-schema.sql
   ```

3. **部署新版本**：
   ```bash
   fly deploy ./ops/litellm -a litellm-dev
   ```

⚠️ **永远先同步 schema 再部署**，否则可能导致服务崩溃或数据不一致。

## 构建与发布

**必须把 `ops/litellm` 作为构建上下文**,否则 Docker 找不到 `litellm_config.yaml`。

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

### Prisma 迁移超时 / Worker 进程崩溃

**症状：** 
- 部署时日志显示 "Running prisma migrate deploy" 后卡住
- 或者服务已启动但不断报 "Child process died" 和 "prisma schema out of sync with db"

**原因：**
1. **Prisma 迁移耗时过长**：数据库连接慢、迁移任务多、或内存不足
2. **Schema 不同步**：即使设置了 `DISABLE_SCHEMA_UPDATE=true`，LiteLLM 仍会检测 schema 差异并导致工作进程崩溃

**解决方案：手动同步数据库 schema**

1. **使用提供的 SQL 脚本**：
   ```bash
   # 在 Supabase Dashboard 的 SQL Editor 中执行 sync-schema.sql
   # 或使用 psql 命令行：
   psql "postgresql://postgres:PASSWORD@HOST:5432/postgres?options=-c%20search_path%3Dlitellm" \
     -f ops/litellm/sync-schema.sql
   ```

2. **手动执行日志中的 SQL**（如果 schema 继续变化）：
   - 查看 fly logs 中 "Required SQL commands:" 后列出的 SQL 语句
   - 在 Supabase SQL Editor 中逐条执行（注意：需要手动加上 `litellm.` schema 前缀）

3. **设置环境变量跳过自动迁移**（已设置）：
   ```bash
   fly secrets set DISABLE_SCHEMA_UPDATE=true PRISMA_OFFLINE_MODE=true -a litellm-dev
   ```

⚠️ **重要**：每次 LiteLLM 镜像更新后，如果 Prisma schema 有变化，需要重新执行一次 schema 同步

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
