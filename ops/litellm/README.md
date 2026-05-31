# LiteLLM 部署

**最后更新**: 2026-04-14

**重要配置：**
- ✅ `DISABLE_SCHEMA_UPDATE=true` - fly.toml env 禁用 app 启动时自动迁移
- ✅ `release_command` - deploy 时通过 `--skip_server_startup` 执行一次 Prisma migration
- ✅ `prod` 使用 `auto_stop_machines = false` 保持服务持续运行
- ✅ `dev` 也使用 `auto_stop_machines = false` + `min_machines_running = 1`，避免冷启动抖动
- ⚠️ **不使用 `--num_workers`** - LiteLLM 官方推荐单进程模式

**为什么不用多 worker？**
- LiteLLM 存在内存泄漏，worker 进程会崩溃
- 官方文档明确建议 Kubernetes/容器环境只用 1 worker
- 正确的扩展方式：单进程 + 水平扩展（多机器）

## 数据库 Migration 架构

**核心设计：Migration 与 App 启动分离**（参考 [LiteLLM Production Best Practices](https://docs.litellm.ai/docs/proxy/prod)）

```
deploy 时:  release_command → litellm --skip_server_startup → prisma migrate deploy → 退出
app 启动:   DISABLE_SCHEMA_UPDATE=true → 跳过 migration → 秒起
```

| 场景 | 行为 |
|---|---|
| 首次部署 | release_command 自动建所有表 |
| 版本升级 | release_command 自动 apply 新 migration |
| 正常重启 | 跳过 migration，秒起 |
| 水平扩展 | 新机器不跑 migration，避免竞争 |

**为什么不在每次启动时跑 migration？**
- Prisma 每次启动跑 `migrate deploy` + `migrate diff`，在 `shared-cpu` 机器上耗时 40+ 秒
- 频繁触发 `asyncio.exceptions.CancelledError` 导致服务崩溃
- 官方推荐：migration 只在 deploy 时跑一次（Helm PreSync Hook / Fly release_command）

### 配置文件

**`fly.toml`**（dev/prod）：
```toml
[env]
  DISABLE_SCHEMA_UPDATE = 'true'

[deploy]
  release_command = "--config /app/config.yaml --skip_server_startup"
```

**`litellm_config.yaml`**：
```yaml
general_settings:
  database_url: os.environ/DATABASE_URL
```

**加密 `.env` 文件**：
```env
DATABASE_URL=postgresql://postgres:PASSWORD@HOST:5432/postgres?schema=litellm
```

`?schema=litellm` 是 Prisma 参数，告诉 Prisma 在 `litellm` schema 下建表和迁移，不碰 `public`。

## 快速更新配置(跳过构建)

当 `fly deploy` 因 Depot builder 超时失败时，使用此方法快速更新 fly.toml 配置：

```bash
# 1. 获取当前镜像
CURRENT_IMAGE=$(fly machines list -a proactive-ai-litellm-dev --json | jq -r '.[0].image_ref.registry + "/" + .[0].image_ref.repository + ":" + .[0].image_ref.tag')

# 2. 使用现有镜像重新部署，应用新配置
fly deploy -a proactive-ai-litellm-dev --config ops/litellm/fly.litellm-dev.toml --image "$CURRENT_IMAGE" --strategy immediate

# 3. 验证配置
fly config show -a proactive-ai-litellm-dev

# prod 同理，替换 app name 和 config 文件
fly deploy -a proactive-ai-litellm-prod --config ops/litellm/fly.litellm-prod.toml --image "$CURRENT_IMAGE" --strategy immediate
```

**原理**: 跳过镜像构建，直接用现有镜像重新部署并应用 fly.toml 中的新配置。

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

## Locust 压测（支持 local/prod）

已提供压测脚本与模板：
- `ops/litellm/locustfile.py`
- `ops/litellm/.env.loadtest.example`

### 1) 安装 Locust

```bash
pip install locust
```

### 2) 准备压测配置

```bash
cp ops/litellm/.env.loadtest.example ops/litellm/.env.loadtest
```

可按需修改：
- `LITELLM_LOADTEST_TARGET=local|prod`
- `LITELLM_LOCAL_BASE_URL`（本地地址）
- `LITELLM_PROD_BASE_URL`（云上地址）
- `LITELLM_BASE_URL`（自定义地址，优先级最高）
- `LITELLM_API_KEY`（目标服务开启鉴权时必填）
- `LITELLM_MODEL`（建议 `fake-openai-endpoint`）

### 3) 启动 Web UI 压测

```bash
set -a
source ops/litellm/.env.loadtest
set +a
locust -f ops/litellm/locustfile.py
```

打开 `http://127.0.0.1:8089`，可参考：
- Users: `100`
- Ramp up (spawn rate): `10`
- Host: 可留空（脚本会用环境变量自动选择 local/prod），也可手动覆盖

### 4) 直接命令行（headless）

本地：
```bash
set -a && source ops/litellm/.env.loadtest && set +a
LITELLM_LOADTEST_TARGET=local \
locust -f ops/litellm/locustfile.py --headless --users 100 --spawn-rate 10 --run-time 5m
```

云上：
```bash
set -a && source ops/litellm/.env.loadtest && set +a
LITELLM_LOADTEST_TARGET=prod \
locust -f ops/litellm/locustfile.py --headless --users 100 --spawn-rate 10 --run-time 5m
```

### 5) 默认压测行为

- 默认只压 `GET /health/readiness`（权重 10）
- 可通过 `LITELLM_ENABLE_CHAT_TEST=true` 打开 `POST /chat/completions`（权重 1）
- `chat` 测试默认模型为 `fake-openai-endpoint`，避免产生真实模型费用

## 版本管理

**重要：** Dockerfile 和 `docker-compose.yml` 都使用固定版本标签（如 `v1.86.2`）而不是滚动标签（如 `main-stable`），以避免自动更新导致数据库 schema 不一致。两处版本必须一致：线上 fly 构建走 Dockerfile，本地 compose 直接 pull `docker-compose.yml` 里的 `litellm.image`。

> LiteLLM 从 1.84.0 起改用纯 SemVer 命名，不再有 `-stable` 后缀：weekly stable 走 MINOR（`1.84.0` → `1.85.0` → `1.86.0`），hotfix 走 PATCH（`1.86.1` / `1.86.2`）。升级时 pin 到最新 hotfixed 的 weekly stable。

### 更新 LiteLLM 版本

1. **修改版本号（Dockerfile + docker-compose.yml 两处同步）**：
   ```dockerfile
   # ops/litellm/Dockerfile
   FROM docker.litellm.ai/berriai/litellm:vX.YY.Z
   ```
   ```yaml
   # docker-compose.yml → services.litellm.image
   image: docker.litellm.ai/berriai/litellm:vX.YY.Z
   ```

2. **部署**：
   ```bash
   git add ops/litellm/Dockerfile
   git commit -m "chore(litellm): update to vX.XX.XX"
   git push  # 触发自动部署
   ```

3. **等待 release_command 完成迁移** - 查看日志确认：
   ```bash
   fly logs -a litellm-dev
   # release_command 会自动跑 prisma migrate deploy
   # 完成后 app 正常启动
   ```

无需手动设置/移除 `DATABASE_URL`，release_command 自动处理。

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

**解决方案：** 已通过 `DISABLE_SCHEMA_UPDATE=true` + `release_command` 解决。Migration 只在 deploy 时执行一次。

### 401 Invalid proxy server token

若 apis 调用 LiteLLM 管理接口报 401，说明 **apis 发的是虚拟 key (sk-xxx)，而不是 master key**。

**处理：** 在 apis 的 `LITELLM_MASTER_KEY` 里填的值，必须与 LiteLLM 服务端环境变量 `LITELLM_MASTER_KEY` **完全一致**（即你在 LiteLLM 里配置的管理密钥）。不能填任何由 LiteLLM 生成的虚拟 key（sk- 开头）。

### 切 Volcengine/SEED 后仍回退到 Claude

**典型症状：**
- OpenClaw 日志显示主模型是 `litellm/volcengine/<endpoint_id>`，但会话仍跑到 Claude。
- LiteLLM 日志出现：
  - `Invalid model name passed in model=volcengine/<endpoint_id>`
  - 或 `VolcengineException - The API key doesn't exist`

**根因拆解：**
1. 模型未注册到 LiteLLM，可用模型列表里找不到该 `volcengine/<endpoint_id>`，触发 fallback。
2. 即使模型已注册，如果 `api_base` 区域不匹配（BytePlus 常见为 ap-southeast），也会鉴权失败并回退。

**标准处理顺序：**
1. 确保 LiteLLM 允许动态入库模型：
   ```bash
   fly secrets set STORE_MODEL_IN_DB='True' -a litellm-dev
   ```
2. 用 LiteLLM 管理接口注册模型（`/model/new`）。
3. 立刻更新该模型的 `api_base` 到实际区域（如 `https://ark.ap-southeast.bytepluses.com/api/v3`，走 `/model/update`）。
4. 在 apis 侧设置：
   - `LITELLM_OPENCLAW_DEFAULT_MODEL=volcengine/<endpoint_id>`
   - `LITELLM_ALLOWED_MODELS` 包含该模型
5. 重建/ensure assistant machine，让新配置下发到 OpenClaw。

**快速验证：**
- `GET /v1/models` 能看到 `volcengine/<endpoint_id>`
- `POST /chat/completions` 指定该模型返回 200
- OpenClaw 不再出现 `Invalid model name` / `API key doesn't exist`

### Schema 不一致

**症状：** 
- 部署时 release_command 日志显示 migration error
- 或者服务报 "relation X does not exist"

**处理：**
参考 [LiteLLM Prisma Migration Troubleshooting](https://docs.litellm.ai/docs/troubleshoot/prisma_migrations)。
通常删除 `_prisma_migrations` 中失败的记录后重新 deploy 即可。

## 构建与发布

**必须把 `ops/litellm` 作为构建上下文**,否则 Docker 找不到 `litellm_config.yaml`。

- 在仓库根目录执行：
  ```bash
  fly deploy ./ops/litellm -c ops/litellm/fly.litellm-dev.toml -a proactive-ai-litellm-dev
  ```
- 或在 `ops/litellm` 目录下执行：
  ```bash
  cd ops/litellm && fly deploy -c fly.litellm-dev.toml -a proactive-ai-litellm-dev
  ```
