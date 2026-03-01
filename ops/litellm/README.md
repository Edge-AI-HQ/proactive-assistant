# LiteLLM 部署

**最后更新**: 2026-03-01 - fly.toml 配置已修复并同步

**重要配置：**
- ✅ `DISABLE_SCHEMA_UPDATE=true` - 禁用自动迁移
- ✅ `auto_stop_machines = false` - 保持服务持续运行  
- ⚠️ **不使用 `--num_workers`** - LiteLLM 官方推荐单进程模式

**为什么不用多 worker？**
- LiteLLM 存在内存泄漏，worker 进程会崩溃
- 官方文档明确建议 Kubernetes/容器环境只用 1 worker
- 正确的扩展方式：单进程 + 水平扩展（多机器）

## 快速更新配置(跳过构建)

当 `fly deploy` 因 Depot builder 超时失败时，使用此方法快速更新 fly.toml 配置：

```bash
# 方法1: 使用脚本(推荐)
cd ops/litellm
./fly-update-config.sh

# 方法2: 手动执行
# 1. 获取当前镜像
CURRENT_IMAGE=$(fly machines list -a litellm-dev --json | jq -r '.[0].image_ref.registry + "/" + .[0].image_ref.repository + ":" + .[0].image_ref.tag')

# 2. 使用现有镜像重新部署，应用新配置
fly deploy -a litellm-dev --image "$CURRENT_IMAGE" --strategy immediate

# 3. 验证配置
fly config show -a litellm-dev
```

**原理**: 跳过漫长的镜像构建过程，直接用现有镜像重新部署并应用 fly.toml 中的新配置。

## 核心问题和解决方案

### 问题：Prisma 自动迁移导致启动缓慢和崩溃

**症状：**
- 启动耗时 40+ 秒
- 日志显示 `Running prisma migrate deploy` 和 `prisma migrate diff` 耗时很长
- 服务不稳定，频繁崩溃（`asyncio.exceptions.CancelledError`）

**根本原因：**
Prisma 会自动识别 `DATABASE_URL` 环境变量，并在启动时执行：
1. `prisma migrate deploy` - 应用待处理的迁移
2. `prisma migrate diff` - 生成并应用 schema 差异（post-migration sanity check）

这些操作即使在设置 `DISABLE_SCHEMA_UPDATE=true` 后仍会执行，因为这些环境变量不是 LiteLLM 官方支持的。

**解决方案：使用自定义环境变量名**

将 `DATABASE_URL` 改为 `LITELLM_DB_URL`，并在 `litellm_config.yaml` 中显式读取：

```yaml
general_settings:
  database_url: os.environ/LITELLM_DB_URL
```

这样 Prisma 不会自动识别数据库连接，避免自动触发迁移检查。

### 配置文件

**ops/litellm/.env**（本地开发）：
```env
LITELLM_DB_URL=postgresql://postgres:PASSWORD@HOST:5432/postgres?schema=litellm
```

**Fly.io secrets**（生产环境）：
```bash
fly secrets set LITELLM_DB_URL='postgresql://postgres:PASSWORD@HOST:5432/postgres?schema=litellm' -a litellm-dev
```

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

### 健康检查配置

```toml
[[http_service.checks]]
  grace_period = "60s"  # 给予 60 秒启动时间
  interval = "30s"
  method = "GET"
  timeout = "10s"
  path = "/health"
```

健康检查的 `/health` 端点需要认证，所以会返回 401，但这不影响服务正常运行。

**重要：** `auto_stop_machines = false` 确保服务持续运行，不会自动停止。

## 版本管理

**重要：** Dockerfile 使用固定版本标签（如 `v1.81.12-stable`）而不是滚动标签（如 `main-stable`），以避免自动更新导致数据库 schema 不一致。

### 更新 LiteLLM 版本

由于使用了 `LITELLM_DB_URL` 而非 `DATABASE_URL`，Prisma 不会自动运行迁移。更新版本时需要手动处理 schema 变更。

**⚠️ 重要：按顺序执行以下步骤**

1. **临时恢复 DATABASE_URL 以允许迁移**：
   ```bash
   fly secrets set DATABASE_URL='postgresql://postgres:PASSWORD@HOST:5432/postgres?schema=litellm' -a litellm-dev
   ```

2. **修改 Dockerfile 版本号**：
   ```dockerfile
   FROM docker.litellm.ai/berriai/litellm:v1.XX.XX-stable
   ```

3. **部署新版本**：
   ```bash
   git add ops/litellm/Dockerfile
   git commit -m "更新 LiteLLM 到 vX.XX.XX"
   git push  # 触发自动部署
   ```

4. **等待迁移完成** - 查看日志确认：
   ```bash
   fly logs -a litellm-dev
   # 等待看到 "✅ Post-migration sanity check completed"
   # 和 "INFO: Uvicorn running on http://0.0.0.0:4000"
   ```

5. **移除 DATABASE_URL，恢复 LITELLM_DB_URL**：
   ```bash
   fly secrets unset DATABASE_URL -a litellm-dev
   fly secrets set LITELLM_DB_URL='postgresql://postgres:PASSWORD@HOST:5432/postgres?schema=litellm' -a litellm-dev
   ```

### 为什么需要这些步骤

- **LITELLM_DB_URL**: 自定义环境变量名，避免 Prisma 自动识别触发迁移检查
- **更新时临时使用 DATABASE_URL**: 允许新版本自动处理 schema 变更
- **迁移完成后恢复 LITELLM_DB_URL**: 避免每次重启都运行迁移（提高启动速度，减少崩溃风险）

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

LiteLLM 使用 **PostgreSQL schema 隔离**，与 apis 共用一个数据库但使用不同的 schema。

### 步骤（一次性）

1. **在库里建 schema**（与 apis 同库执行一次即可）：
   ```sql
   CREATE SCHEMA IF NOT EXISTS litellm;
   ```

2. **LiteLLM 的连接串** 使用 `?schema=litellm` 参数：
   ```
   postgresql://postgres:PASSWORD@HOST:5432/postgres?schema=litellm
   ```

这样 LiteLLM 的表和 `_prisma_migrations` 都会建在 `litellm` schema，不会动 `public` 下的业务表。

### 用独立库

若不想共用库，可新建一个库（如 Supabase 再建一个 project），连接串无需加 `?schema=litellm`。

## 常见问题

### 启动缓慢或频繁崩溃

**症状：** 
- 启动耗时 40+ 秒
- 日志显示 `prisma migrate diff` 耗时很长
- 服务崩溃报 `asyncio.exceptions.CancelledError`

**解决方案：** 使用 `LITELLM_DB_URL` 而非 `DATABASE_URL`（见上方"核心问题和解决方案"）

### 401 Invalid proxy server token

若 apis 调用 LiteLLM 管理接口报 401，说明 **apis 发的是虚拟 key (sk-xxx)，而不是 master key**。

**处理：** 在 apis 的 `LITELLM_MASTER_KEY` 里填的值，必须与 LiteLLM 服务端环境变量 `LITELLM_MASTER_KEY` **完全一致**（即你在 LiteLLM 里配置的管理密钥）。不能填任何由 LiteLLM 生成的虚拟 key（sk- 开头）。

### Schema 不一致（历史问题，新部署已解决）

**症状：** 
- 部署时日志显示 "Running prisma migrate deploy" 后卡住
- 或者服务报 "prisma schema out of sync with db"

**处理：**
现在使用 `LITELLM_DB_URL`，Prisma 不会自动运行迁移。如果需要手动同步 schema，参考"版本管理"章节。
