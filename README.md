# PIN AI Assistant Monorepo

PIN AI Assistant 仓库说明文档。

## 当前架构（一句话）

- `apis`：统一后端（HTTP API + Telegram 引导 Bot + Gateway/Auth + Payment 页面）
- `ops/litellm`：LiteLLM 独立部署脚本与配置

> 说明：原 `apps/pinclaw-bot` 已合并进 `apis`，当前由 `apis` 单进程承载 bot 与 API。

## 目录结构

```text
.
├── apis/                     # 统一后端
│   ├── src/
│   │   ├── controller/       # HTTP/WS 路由注册
│   │   └── domain/           # auth, telegram-bot, user, claw-assistant, container, payment, gateway
│   └── db/migrations/        # 数据库迁移 SQL
├── ops/litellm/              # LiteLLM 启停脚本与配置
├── infra/                    # 基础设施相关模块
└── docs/                     # 项目文档
```

## 运行拓扑

- `apis` 默认监听 `:3000`
- Telegram webhook 回调入口：`POST /webhook/telegram`（同一进程内处理 bot update）
- Gateway 与登录页面由 `apis` 提供：`/gateway/*`、`/auth/telegram/*`
- 支付页面与 Stripe webhook 由 `apis` 提供：`/api/payment/*`
- `apis` 通过 `SUPABASE_DB_URL` 连接 Postgres
- `apis` 通过 `LITELLM_BASE_URL` 调用独立部署的 LiteLLM
- `apis` 通过 `CONTAINER_RUNTIME` 选择 Docker/Fly 运行 assistant 容器

## 环境变量

### 1) `apis`（后端 + Telegram Bot）

模板：`apis/.env.example`

核心必配（默认场景）：
- `SUPABASE_DB_URL`
- `API_INTERNAL_TOKEN`
- `STRIPE_SECRET_KEY`
- `LITELLM_ENABLED=true` 时：`LITELLM_MASTER_KEY`

Telegram 相关（启用 bot / gateway 登录）：
- `TELEGRAM_BOT_TOKEN`
- `PUBLIC_BASE_URL`（用于 webhook URL 与页面回跳）
- 可选：`TELEGRAM_WEBHOOK_SECRET`、`TELEGRAM_BOT_USERNAME`

支付相关：
- `STRIPE_WEBHOOK_SECRET`
- `PAYMENT_PUBLIC_BASE_URL`（未配置时会基于请求推断）
- 可选：`CRON_SECRET`（用于 internal 定时任务：credits-maintenance、apply-subscription-period-budgets）

常用选配：
- `LITELLM_BASE_URL` / `LITELLM_CONTAINER_BASE_URL`
- `CONTAINER_RUNTIME=docker|fly`
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`

### 2) 环境文件加载顺序

`apis` 按顺序尝试加载（`override=false`）：
1. `<repo>/.env`
2. `<repo>/.env.local`
3. `apis/.env`
4. `apis/.env.local`

## 数据库迁移

迁移目录：`apis/db/migrations`

当前迁移文件：
1. `001_unified_schema.sql` - 核心 schema + billing（包含 VNC 和 pending actions）
2. `002_litellm_identity_unification.sql`
3. `003_user_litellm_shared_key.sql`
4. `004_drop_admin_schema.sql`
5. `005_add_missing_litellm_columns.sql`
6. `006_cleanup_user_runtime_instances.sql`
7. `007_payment_event_ordering.sql`
8. `008_fix_subscription_status.sql`
9. `008_remove_wallet_ledger_tables.sql`
10. `009_drop_user_assistant_bot_columns.sql`
11. `010_remove_litellm_key_encryption.sql`
12. `011_rename_litellm_virtual_key_column.sql`
13. `012_fix_subscription_sync_schema.sql`
14. `014_simplify_credits_to_monthly_only.sql`
15. `019_add_vnc_and_pending_actions.sql` - ✅ 已执行到云端

建议：
- 新库或老库升级前先阅读 `apis/db/README.md`
- 手工执行时按上面顺序完整执行一次

## 本地启动（推荐）

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp apis/.env.example apis/.env
cp ops/litellm/.env.example ops/litellm/.env
```

3. 应用数据库迁移（见上文）

4. 启动统一后端（含 Telegram bot）

```bash
npm run dev
```

5. （可选）启动 LiteLLM 容器

```bash
npm run litellm:up
```

## 根脚本速查

- `npm run dev`：启动 `@pin-ai/apis`（开发模式）
- `npm run build`：构建 `@pin-ai/apis`
- `npm run start`：运行 `apis/dist/src/server.js`
- `npm run type-check`：TS 类型检查
- `npm run litellm:up|restart|logs|cleanup-local-db|verify-db-env`

## API 鉴权模型

- 通用 `/api/*` 业务接口使用 `x-api-key`（值为 `API_INTERNAL_TOKEN`）
- 当 `API_INTERNAL_TOKEN` 未配置时，部分通用接口会放行（开发态友好）
- 支付内部接口（`/api/payment/internal/*`）严格要求 `API_INTERNAL_TOKEN`
- `/api/payment/internal/credits-maintenance` 与 `/api/payment/internal/apply-subscription-period-budgets` 额外支持 `Authorization: Bearer <CRON_SECRET>`

## 主要接口（按模块）

### Health / Telegram Webhook
- `GET /health`
- `POST /webhook/telegram`

### User
- `POST /api/user/ensure`
- `GET /api/user/:telegram_user_id`
- `DELETE /api/user/:telegram_user_id`

### Claw Assistant
- `POST /api/claw-assistant/provision`
- `POST /api/claw-assistant/create-without-container`
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
- `GET /api/payment/internal/credits-maintenance`
- `POST /api/payment/internal/apply-subscription-period-budgets`（对「当前时间已进入且未应用」的订阅周期执行 LiteLLM reset spend + set budget；apis 进程内每 5 分钟也会自动执行，无需单独配 Fly.io 定时任务；此接口可供外部 cron 可选调用）
- `GET /api/payment/subscribe`
- `POST /api/payment/create-checkout`
- `POST /api/payment/cancel-subscription`
- `POST /api/payment/webhook/stripe`

### VNC Remote Desktop
- `POST /api/vnc/request-access/:assistantId` - 生成 VNC 访问令牌（15 分钟有效期）
- `GET /vnc/:token` - noVNC 客户端页面（WebSocket 连接到容器桌面）

## Telegram Bot 命令（当前）

- `/start`
- `/create_claw_assistant`
- `/list_claw_assistant`
- `/gateway`
- `/vnc_access` - 获取远程桌面访问链接（用于浏览器密码输入、验证码等 GUI 交互）
- `/cancel_subscription`

## 开发校验

```bash
npm run type-check
npm run build
```

## VNC 远程桌面功能

OpenClaw 容器集成了 TigerVNC 远程桌面，允许用户通过浏览器访问容器的桌面环境，用于处理需要 GUI 交互的任务。

### 架构

- **VNC 服务器**: TigerVNC（端口 8444）
- **桌面环境**: Xfce4（轻量级）
- **浏览器**: Firefox ESR + Chromium
- **前端**: noVNC（HTML5 VNC 客户端，通过 WebSocket 连接）

### 使用流程

1. 用户在 Telegram 发送 `/vnc_access` 命令
2. Bot 生成临时访问链接（15 分钟有效期）
3. 用户点击链接，浏览器加载 noVNC 客户端
4. 自动连接到容器 VNC 服务（默认密码: `pinai123`）
5. 进入 Xfce4 桌面，可以打开浏览器进行操作

### 部署步骤

1. **运行数据库迁移** ✅ 已完成
```bash
# 迁移已执行到云端数据库
# psql $DATABASE_URL -f apis/db/migrations/019_add_vnc_and_pending_actions.sql
```

2. **重新构建 OpenClaw 镜像**
```bash
cat > .fly-openclaw-build.toml << 'EOF'
app = 'pinclaw-api-dev'
[build]
  dockerfile = 'infra/container-manager/images/openclaw/Dockerfile'
EOF

flyctl deploy . \
  --config .fly-openclaw-build.toml \
  --build-only --push \
  --image-label openclaw-vnc \
  --remote-only --depot=false

rm -f .fly-openclaw-build.toml
```

3. **更新 OpenClaw 镜像环境变量**
```bash
# 从构建输出获取 digest（格式: registry.fly.io/pinclaw-api-dev@sha256:xxxxx）
flyctl secrets set \
  OPENCLAW_IMAGE=registry.fly.io/pinclaw-api-dev@sha256:<digest> \
  -a pinclaw-api-dev
```

4. **销毁现有容器**（用户下次启动时会自动使用新镜像）
```bash
flyctl machines list -a pinclaw-api-dev | grep assistant-
flyctl machines destroy <machine-id> -a pinclaw-api-dev --force
```

### 安全特性

- ✅ 临时访问令牌（15 分钟有效期）
- ✅ 所有权验证（只有助理所有者可生成令牌）
- ✅ 访问审计（记录访问时间和 IP）
- ✅ 密码持久化（存储在 volume，重启后保留）
- ⚠️ 默认密码 `pinai123`（建议后续支持自定义）

### 故障排查

**VNC 无法连接**:
```bash
# SSH 进入容器
flyctl ssh console -a pinclaw-api-dev --machine <machine-id>

# 查看日志
cat /tmp/tigervnc.log
cat /tmp/fly-vnc-ipv6-proxy.log

# 检查进程和端口
ps aux | grep vnc
netstat -tlnp | grep 8444
```

**令牌过期**: 用户重新发送 `/vnc_access` 命令生成新链接

## 额外说明

- LiteLLM 仍是独立部署，不在 `apis` 进程内运行。
- Docker runtime 需要可用 OpenClaw 镜像（默认 `OPENCLAW_IMAGE=pinai-openclaw:latest`）。
- 若使用 webhook，`PUBLIC_BASE_URL` 必须可被 Telegram 访问。
- VNC 功能需要容器镜像包含桌面环境（见 `infra/container-manager/images/openclaw/Dockerfile`）。

## OpenClaw 远程桌面 (VNC) 功能

OpenClaw 容器集成了 TigerVNC 远程桌面，用户可以通过浏览器访问容器的桌面环境来处理需要 GUI 交互的任务。

### 功能特性

- **桌面环境**: Xfce4（轻量级）
- **浏览器**: Firefox ESR + Chromium
- **访问方式**: noVNC WebSocket 客户端（无需额外插件）
- **默认密码**: `pinai123`
- **分辨率**: 1920x1080 @ 24bit
- **端口**: 8444（通过 IPv6 代理暴露）

### 使用流程

1. 用户在 Telegram 发送 `/vnc_access` 命令
2. Bot 生成临时访问链接（15 分钟有效期）
3. 用户点击链接打开 noVNC 客户端
4. 自动连接到容器 VNC 服务（密码自动填充）
5. 在桌面环境中打开浏览器，完成密码输入、验证码等操作

### 安全机制

- **临时令牌**: 64 字节随机 token，数据库存储
- **有效期限**: 15 分钟自动过期
- **所有权验证**: 仅助理所有者可生成访问链接
- **审计日志**: 记录访问时间和 IP 地址
- **网络隔离**: VNC 端口不直接暴露，通过 Fly.io 内部网络访问

### 数据库迁移

```sql
-- 018_add_vnc_access_tokens.sql
CREATE TABLE vnc_access_tokens (
  id SERIAL PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  token VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  used_from_ip VARCHAR(45)
);
```

### 部署步骤

1. 运行数据库迁移 `018_add_vnc_access_tokens.sql`
2. 重新构建 OpenClaw 镜像（包含 TigerVNC + Xfce4）
3. 更新 `OPENCLAW_IMAGE` 环境变量（必须使用 `@sha256:` digest 格式）
4. 销毁现有容器，用户下次启动时自动使用新镜像

### 故障排查

- **VNC 无法连接**: 检查容器日志 `/tmp/tigervnc.log` 和 IPv6 代理日志
- **桌面未启动**: 检查 `/root/.vnc/xstartup` 权限和内容
- **令牌过期**: 用户重新发送 `/vnc_access` 命令

### 性能影响

| 组件 | 内存占用 |
|------|---------|
| TigerVNC | ~20MB |
| Xfce4 桌面 | ~80MB |
| Firefox (空闲) | ~150MB |
| **总计** | ~250MB |

容器推荐内存: 1GB（OpenClaw 512MB + 桌面 250MB + 缓冲）

## 支付与订阅：事件与测试

- **正常续费**：周期结束前 Stripe 自动扣款；成功→`invoice.paid`（重置 spend + 设 budget），失败→多次重试后 `customer.subscription.updated`（past_due/unpaid）→ 我们清零 budget 并停/毁该用户所有 assistant 容器（Docker 停、Fly 毁）。
- **取消订阅（周期末）**：用户取消后 `cancel_at_period_end=true`，本期继续用；到 period_end 收到 `customer.subscription.updated` 或 `customer.subscription.deleted`（status=canceled）→ 同样清零 budget、停/毁容器。
- **Gateway 校验**：访问 Gateway/Proxy/WS 前会校验订阅是否有效（`hasActiveSubscriptionForService`），过期或已取消且过 period_end 时返回 **402**，且不会启动新容器。
- 测试：续费成功看 `invoice.paid` 与 LiteLLM budget；续费失败用测试卡 4000 0000 0000 0341 或 Stripe Dashboard 把 invoice 标失败；取消用 Dashboard 选 Cancel at period end；过期访问 Gateway 应得 402。详见 `apis/src/domain/payment/subscriptionSync.ts`、`subscriptionGuard.ts`、`webhook.ts`。

## 参考文档

- `apis/db/README.md`
- `docs/billing-system.md`
- `docs/pinclaw-bot-product-spec.md`
- `docs/pinclaw-bot-use-cases.md`
