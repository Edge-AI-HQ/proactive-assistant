# Repository Guidelines

## 项目结构与模块组织
本仓库以 `apis/` 为核心（Node + TypeScript 后端），辅以路由与运维模块。
- `apis/src/controller/`：HTTP/WS 路由入口。
- `apis/src/domain/`：业务域（`auth`、`payment`、`telegram-bot`、`container` 等）。
- `apis/db/migrations/`：按序执行的数据库迁移 SQL。
- `telegram-router/`：Bun 实现的 Telegram webhook 路由与代理。
- `ops/litellm/`：LiteLLM 启停脚本与部署配置。
- `docs/`：架构、产品和运维文档。

新增功能优先放在 `apis/src/domain/<feature>/`，路由仅做参数校验与调用编排。

## 构建、测试与开发命令
在仓库根目录执行：
- `npm install`：安装依赖。
- `npm run dev`：启动 `@pin-ai/apis` 开发服务。
- `npm run build`：编译 API 到 `apis/dist/`。
- `npm run start`：运行编译产物。
- `npm run type-check`：严格 TypeScript 类型检查。
- `npm run test --workspace @pin-ai/apis`：运行 `*.test.ts` 测试。
- `npm run litellm:up` / `npm run litellm:logs`：管理本地 LiteLLM。
- `cd telegram-router && bun run dev`：本地启动 Telegram Router。

## 代码风格与命名规范
- 使用 TypeScript ESM（`NodeNext`），保持 `strict` 通过。
- 缩进 2 空格；保持函数短小、职责单一。
- 命名约定：变量/函数 `camelCase`，类型/类 `PascalCase`。
- 路由层保持薄，业务逻辑下沉到 `domain`。
- 仓库未统一 ESLint/Prettier 配置，提交前至少执行 `npm run type-check`。

## 测试规范
- 主测试方式：`tsx --test`（位于 `apis` 工作区）。
- 测试文件命名：`*.test.ts`，建议与被测模块就近放置。
- 新增逻辑至少覆盖：主流程、关键失败分支、回归路径。
- Router 联调可使用：`telegram-router/test.sh`、`telegram-router/test-full.sh`。

## 提交与 PR 规范
- 遵循 Conventional Commits：如 `feat(telegram-router): ...`、`fix(litellm): ...`。
- 每次提交聚焦单一变更点；PR 说明需包含背景、改动、验证步骤、配置/迁移影响。
- 若涉及页面或机器人流程变更，附关键日志、请求示例或截图。

## 代理规则单一真源
- `AGENTS.md` 为规则单一真源（SSOT）。
- 新版 Cursor 规则入口使用 `.cursor/rules/agents.mdc`，并应软链接到 `AGENTS.md`。
- `CLAUDE.md`、`GEMINI.md` 保持指向 `AGENTS.md`，兼容不同工具与版本，减少规则漂移。

## 部署排障记录
### Fly.io：depot builder 握手 EOF
现象：
- `flyctl deploy` 在构建阶段失败，常见报错：
- `error releasing builder: deadline exceeded`
- `failed to list workers: Unavailable: connection error: desc = "transport: authentication handshake failed: EOF"`

结论：
- 通常不是 `fly.toml` 配置问题，而是 `depot builder` 链路异常。
- 使用 Fly 远程构建并绕过 depot（`--depot=false`）通常可恢复部署。
- 本地代理（如 `http_proxy/https_proxy/all_proxy=127.0.0.1:7890`）可能提高 depot 的 gRPC/TLS 握手失败概率。

推荐部署命令（稳定）：
```bash
flyctl deploy ./telegram-router -a pinclaw-telegram-router-dev --remote-only --depot=false
```

如果必须使用 depot，先在无代理环境测试：
```bash
env -u all_proxy -u ALL_PROXY -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u no_proxy -u NO_PROXY \
flyctl deploy ./telegram-router -a pinclaw-telegram-router-dev --remote-only --depot=true
```

## Telegram Router 架构与部署

### 架构概览
Telegram Router 是一个独立的 Bun 服务，负责将 Telegram webhook 消息路由到用户对应的 OpenClaw 容器，并代理 OpenClaw 容器的出站 Telegram API 调用。

消息流：
```
Telegram API → telegram-router (入站 webhook) → OpenClaw 容器 (用户助理)
OpenClaw 容器 → telegram-router-proxy 插件 (fetch monkey-patch) → telegram-router (出站代理) → Telegram API
```

### 关键组件
| 组件 | 路径 | 运行时 | 部署目标 |
|------|------|--------|----------|
| Telegram Router 服务 | `telegram-router/` | Bun | `pinclaw-telegram-router-dev` (Fly app) |
| OpenClaw 代理插件 | `openclaw-plugins/telegram-router-proxy/` | Node (OpenClaw 内) | 内置于 OpenClaw 镜像 |
| APIs 容器编排 | `apis/src/domain/container/` | Node | `pinclaw-api-dev` (Fly app, GitHub Actions 自动部署) |

### 部署流程

#### 1. Telegram Router
```bash
flyctl deploy ./telegram-router -a pinclaw-telegram-router-dev --remote-only --depot=false
```

#### 2. OpenClaw 镜像（含 telegram-router-proxy 插件）
采用「薄层自定义镜像」方案：`infra/container-manager/images/openclaw/Dockerfile` 基于官方 OpenClaw 镜像，COPY 插件源码到 `/opt/pinai/plugins/`。

构建并推送到 Fly registry：
```bash
cat > .fly-openclaw-build.toml << 'EOF'
app = 'pinclaw-api-dev'
[build]
  dockerfile = 'infra/container-manager/images/openclaw/Dockerfile'
EOF

flyctl deploy . \
  --config .fly-openclaw-build.toml \
  --build-only --push \
  --image-label openclaw-with-plugin \
  --remote-only --depot=false

rm -f .fly-openclaw-build.toml
```

**注意**：`--build-only` 不会自动推送镜像，必须加 `--push` 参数。

更新 APIs 服务指向新镜像（必须使用 `@sha256:` digest 格式，tag 格式会导致启动失败）：
```bash
flyctl secrets set \
  OPENCLAW_IMAGE=registry.fly.io/pinclaw-api-dev@sha256:<从构建输出获取> \
  -a pinclaw-api-dev
```

#### 3. APIs 服务
APIs 代码变更通过 **Git push → GitHub Actions** 自动部署到 `pinclaw-api-dev`，无需手动 `flyctl deploy`。

### 环境变量与 Secrets

#### telegram-router (Fly secrets)
- `TELEGRAM_BOT_TOKEN` — Telegram Bot Token
- `WEBHOOK_SECRET` — Webhook 签名验证密钥
- `DATABASE_URL` — Postgres 连接串

#### pinclaw-api-dev (Fly secrets)
- `OPENCLAW_IMAGE` — OpenClaw 镜像 digest（**必须** `@sha256:` 格式）
- `TELEGRAM_ROUTER_WEBHOOK_URL` — Router 的入站 webhook 地址
- `OPENCLAW_TELEGRAM_WEBHOOK_PATH` — OpenClaw 容器内 webhook 路径
- `TELEGRAM_WEBHOOK_SECRET` — Webhook 密钥

### 排障要点
- APIs 的 `image_digest_guard.ts` 在启动时校验 `OPENCLAW_IMAGE` 必须是 `registry.fly.io/<app>@sha256:<64-hex>` 格式，tag 格式（如 `:openclaw-with-plugin`）会导致 crash loop。
- 如果 APIs 机器因 crash loop 达到最大重启次数而停止，修复 secret 后需手动 `flyctl machines start <id> -a pinclaw-api-dev`。
- OpenClaw 代理插件使用黑名单机制（`NON_PROXYABLE_TELEGRAM_METHODS`），管理类方法如 `setWebhook`、`getMe` 不代理，其余消息类方法默认代理。
