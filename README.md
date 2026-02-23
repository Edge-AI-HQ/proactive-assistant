# PIN AI Assistant Monorepo

PIN AI Assistant 仓库说明文档。

## 当前架构（一句话）

- `apis`：后端 API（单入口 `apis/src/server.ts`，按 domain 分层）
- `apps/pinclaw-bot`：Telegram 引导 Bot（通过后端 API 完成业务流程）
- `ops/litellm`：LiteLLM 独立部署的脚本和配置

## 目录结构

```text
.
├── apis/                     # 统一后端 API
│   ├── src/
│   │   ├── controller/       # HTTP/WS 路由注册
│   │   └── domain/           # auth, user, claw-assistant, container, payment, meter, gateway
│   └── db/migrations/        # 数据库迁移 SQL
├── apps/pinclaw-bot/         # Telegram 引导 Bot 前端
│   └── src/
│       ├── client.ts         # 后端 API 客户端
│       └── telegram/         # bot 命令和更新处理
├── ops/litellm/              # LiteLLM 启停脚本与配置
└── docs/                     # 项目文档
```

## 运行拓扑

- `apis` 监听默认 `:3000`
- `pinclaw-bot` 监听默认 `:3001`
- bot 通过 `BACKEND_API_BASE_URL` 调用 `apis`
- `apis` 通过 `SUPABASE_DB_URL` 连接 Postgres
- `apis` 通过 `LITELLM_BASE_URL` 调用独立部署的 LiteLLM
- `apis` 根据 `CONTAINER_RUNTIME` 选择 Docker/Fly 运行 assistant 容器

## 环境变量

### 1) `apis`（后端）

模板：`apis/.env.example`

核心必配（默认场景）：
- `SUPABASE_DB_URL`
- `LITELLM_ENABLED=true` 时：
  - `LITELLM_BASE_URL`
  - `LITELLM_CONTAINER_BASE_URL`
  - `LITELLM_MASTER_KEY`
  - `LITELLM_KEY_ENCRYPTION_SECRET`

常用但按功能选配：
- `OPENCLAW_API_KEY`
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME`（如果要启用 Gateway Telegram 登录）

支付开启时（`PAYMENT_ENABLED=true`）：
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_BASIC`
- `STRIPE_PRICE_ID_PRO`
- `STRIPE_PRICE_ID_MAX`
- `API_INTERNAL_TOKEN`（支付内部接口强制要求）

### 2) `apps/pinclaw-bot`（Telegram 前端）

模板：`apps/pinclaw-bot/.env.example`

必配：
- `TELEGRAM_BOT_TOKEN`
- `BACKEND_API_BASE_URL`（例如 `http://127.0.0.1:3000`）

建议：
- `API_INTERNAL_TOKEN`（若后端启用了 API 内部鉴权，必须与后端一致）
- `PUBLIC_BASE_URL`（用于 `/gateway` 链接和 webhook 自动推断）
- `TELEGRAM_UPDATE_MODE=auto|webhook|polling`

### 3) 环境文件加载规则

- `apis` 会按顺序尝试加载：`<repo>/.env` -> `<repo>/.env.local` -> `apis/.env` -> `apis/.env.local`
- `pinclaw-bot` 仅加载：`apps/pinclaw-bot/.env.local` -> `apps/pinclaw-bot/.env`

## 数据库迁移

迁移目录：`apis/db/migrations`

### Fresh DB（新库）

按文件名顺序执行：

1. `001_unified_schema.sql`
2. `002_litellm_identity_unification.sql`
3. `003_user_litellm_shared_key.sql`
4. `004_drop_admin_schema.sql`
5. `005_add_missing_litellm_columns.sql`
6. `006_cleanup_user_runtime_instances.sql`
7. `007_payment_event_ordering.sql`

### Legacy DB（已有 users/assistants 表）

建议顺序：

1. `001_unified_schema.sql`
2. `005_add_missing_litellm_columns.sql`
3. `002_litellm_identity_unification.sql`
4. `003_user_litellm_shared_key.sql`
5. `004_drop_admin_schema.sql`
6. `006_cleanup_user_runtime_instances.sql`
7. `007_payment_event_ordering.sql`

## 本地启动（推荐）

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp apis/.env.example apis/.env
cp apps/pinclaw-bot/.env.example apps/pinclaw-bot/.env
cp ops/litellm/.env.example ops/litellm/.env
```

3. 先应用数据库迁移（按上面的顺序）

4. 启动后端 API

```bash
npm run dev:api
```

5. 新开终端，启动 Telegram Bot 前端

```bash
npm run dev:bot
```

6. （可选）启动 LiteLLM 容器

```bash
npm run litellm:up
```

## 根脚本速查

- `npm run dev` / `npm run dev:api`：启动 `apis`
- `npm run dev:bot`：启动 `pinclaw-bot`
- `npm run build`：构建两个 workspace
- `npm run type-check`：两个 workspace 的 TS 检查
- `npm run lint`：`pinclaw-bot` ESLint
- `npm run litellm:up|restart|logs|cleanup-local-db|verify-db-env`

## API 鉴权模型

- `apis` 的多数 `/api/*` 业务接口通过 `x-api-key` 做内部鉴权（`API_INTERNAL_TOKEN`）。
- 若 `apis` 未配置 `API_INTERNAL_TOKEN`，这些接口默认放行（开发模式友好）。
- 但支付内部接口（`/api/payment/internal/*`）始终要求 `API_INTERNAL_TOKEN`。
- `/api/payment/internal/credits-maintenance` 额外支持 `Authorization: Bearer <CRON_SECRET>`。

## 主要接口（按模块）

### Health
- `GET /health`

### User
- `POST /api/user/ensure`
- `GET /api/user/:telegram_user_id`
- `DELETE /api/user/:telegram_user_id`

### Claw Assistant
- `POST /api/claw-assistant/provision`
- `GET /api/claw-assistant/owner/:telegram_user_id`
- `GET /api/claw-assistant/:assistant_id`
- `DELETE /api/claw-assistant/:assistant_id`

### Container
- `GET /api/container/runtime`
- `POST /api/container/assistant/:assistant_id/create`
- `DELETE /api/container/assistant/:assistant_id`

### Gateway / Auth
- `POST /api/gateway/session`
- `GET /auth/telegram/gateway`
- `GET /auth/telegram/callback`
- `GET /gateway/:user_id/bot/:assistant_id`
- `GET /gateway/:user_id/bot/:assistant_id/proxy/*`
- `WS /gateway/:user_id/bot/:assistant_id/ws`

### Payment
- `GET /api/payment/health`
- `GET /api/payment/plans`
- `POST /api/payment/internal/payment-session`
- `GET /api/payment/internal/subscription`
- `GET /api/payment/internal/payment-session-validate`
- `POST /api/payment/internal/credits-maintenance`
- `GET /api/payment/subscribe`
- `POST /api/payment/create-checkout`
- `POST /api/payment/cancel-subscription`
- `POST /api/payment/webhook/stripe`

### Meter
- `GET /api/meter/budget/:telegram_user_id`
- `POST /api/meter/budget/:telegram_user_id`
- `GET /api/meter/credit-status/:telegram_user_id`
- `POST /api/meter/refresh/daily`
- `POST /api/meter/refresh/monthly`
- `POST /api/meter/webhook/litellm-budget-alert`

## Bot 命令（`apps/pinclaw-bot`）

- `/start`
- `/create_claw_assistant`（兼容旧命令 `/create_pin_claw_assistant`）
- `/list_claw_assistant`（兼容旧命令）
- `/gateway`
- `/subscribe`

## 开发校验（当前仓库状态）

以下命令可通过：

```bash
npm run type-check
npm run build
npm run lint
```

## 额外说明

- LiteLLM 仍是独立部署，不在 `apis` 进程内运行。
- Docker runtime 需要可用的 OpenClaw 镜像（默认 `OPENCLAW_IMAGE=pinai-openclaw:latest`）。
- 当前仓库建议使用上面的 npm 脚本作为主启动路径。

## 参考文档

- `apis/db/README.md`
