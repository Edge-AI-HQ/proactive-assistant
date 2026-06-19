# Repository Guidelines

## 编码原则

写代码和 review 时逐条对照。所有 AI coding 工具和团队成员共同遵守。

1. **先读后写** — 改代码前读懂现有实现的意图。不基于猜测写代码。
2. **用正解不绕过** — 找根因，不 workaround。禁止 `as any`、`@ts-ignore`、`eslint-disable`、`# type: ignore`、`# noqa`，除非注释说明为什么是唯一选项。
3. **改动最小化** — 只改该改的。不顺手重构，不加无关改善。
4. **用业界标准做法** — 业界有成熟 pattern 的功能直接用通用方案，不自己设计。同模块已有 pattern 就复用，不发明新写法。
5. **系统视角** — 改动前考虑在整个系统中的位置，接口变更考虑上下游，数据变更考虑迁移。
6. **边界防御，内部信任** — 系统边界做防御性处理，内部代码信任类型系统。
7. **高效** — 注意复杂度和不必要的 IO，但不为微优化牺牲可读性。
8. **低冗余不过度抽象** — 消除真正的重复。三行重复优于只用一次的抽象。
9. **关键路径可观测** — 状态变更和系统边界留日志，能定位问题即可。
10. **写完自审** — 实现完成后 review 完整 diff，对照以上原则检查，发现问题立即修。

## 当前架构

Proactive AI 后端整体收敛到 **pinai-agents**（Python / FastAPI / LangChain + DeepAgents）；内部卡片 review 工具是 **internal-reward-dashboard**（独立 Vite React app，登录走 Supabase Auth）。LLM 统一经 **LiteLLM** 路由。

用户产品前端是「**一套共享层 + 多个端壳**」：跨端逻辑与 UI 沉在 `packages/*`，各端只写壳。

共享层 `packages/`（自底向上，包间边界由根 `eslint.config.mjs` 规则强制）：
- `@pin-ai/core` — 纯 TS：transport/SSE、API 域函数、域类型、纯状态机、平台 ports 接口（禁 react / capacitor / electron / 浏览器 globals）。
- `@pin-ai/design` — 跨端设计 token SSOT（`tokens.cjs/mjs/json`，web Tailwind 与 RN NativeWind 共用，改色值只改这里）。
- `@pin-ai/state` — 跨端 React hooks：TanStack Query / zustand / 业务编排 / auth glue，依赖 core（禁 react-dom / 平台 API）。
- `@pin-ai/ui-kit` — 双端设计系统层：`cn` 工具 / 组件契约 / cva variant / motion 预设，平台无关，web 与 RN 共享，依赖 design。
- `@pin-ai/ui-web` — web 介质层：React DOM 组件 + 平台 hooks，硬标准「纯 web 可运行」，依赖 core/design/ui-kit。

端壳：
- **apps/web** — zebra 设计的桌面 web 端（Vite + React 19 + react-router），消费 core/state/ui-web，**已上线 dev/prod**。设计 SSOT：[`docs/plans/2026-06-12-zebra-web-app-port.mdx`](docs/plans/2026-06-12-zebra-web-app-port.mdx)。
- **apps/desktop** — Electron macOS 壳，renderer 复用 apps/web 的 Vite root（「一套 zebra UI、web + 桌面两个壳」），桌面侧只有 main + preload。仅本地 `make macos`，暂无自动部署。
- **apps/mobile** — Expo / React Native iOS app，UI 独立实现，业务层消费 core/design/state/ui-kit（不碰 ui-web）。**仍在开发、未上线**，CI 自动构建已禁用。
- **proactive-ai-frontend** — Capacitor（Vite + Tailwind）React SPA，**当前生产 iOS 前端**，消费 core/state/ui-kit/ui-web/design；apps/mobile（RN）是它的未来接替者，接替前 iOS 仍以它为准。

三个 web 端（proactive-ai-frontend / apps/web / apps/desktop）经 vite alias + tsconfig paths 直引 `packages/*/src`（无 build 步骤，改包即时生效）；apps/mobile 走 npm workspace 依赖（metro 解析）。前端分层 SSOT：[`research/2026-06-10-frontend-layering.mdx`](research/2026-06-10-frontend-layering.mdx)；双端设计系统 SSOT：[`docs/plans/2026-06-13-dual-platform-design-system.mdx`](docs/plans/2026-06-13-dual-platform-design-system.mdx)。

`apis/`（Node 后端 + 容器编排 + gateway）、`pinai-openclaw/`（用户容器镜像 + plugin）、`miniapp/`（Telegram mini app）三个老仓目录已经移除，所有职责都搬到 pinai-agents：

- 控制面（auth / device / connector / payment / scheduler / migrations）→ `pinai-agents` 的 **web 进程**。
- LLM 链路（chat / generate / dreaming agents + Daytona sandbox 工具）→ `pinai-agents` 的 **chat 进程**。
- 两个进程共用一个 fly app（`[processes]` 切分），共用一份镜像。
- 用户级 OpenClaw 容器和 gateway 代理整套都退役了，前端直接打 pinai-agents HTTP/SSE。

## 进程信任边界（web vs chat）

pinai-agents 在同一 codebase 里跑两个进程，**单一信任边界**：

- **web 进程**：持 master credentials（`SUPABASE_SECRET_KEY` / `PAI_JWT_SIGNING_KEY` / `COMPOSIO_API_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `LITELLM_MASTER_KEY`）。负责签 JWT、mint LiteLLM virtual key、写入 Supabase Storage、调 Supabase Auth admin API、跑 Composio ingest 等"代表用户"的动作。
- **chat 进程**：跑 LLM loop，**不能**看到 master credentials。和 web 之间走 HTTPS + EdDSA（Ed25519）签名的 per-run JWT，输入视为不可信。
- **运行时防线现状**（FORBIDDEN_ENVS 单一真源：`pinai-agents/src/pinai_agents/chat/trust_boundary.py`）：
  - **本地 compose 仍生效**：Makefile `ensure-env-pinai-agents` 派生 `.env.chat`，本地 chat 容器看不到 master credentials。
  - **fly 部署上暂时降级**：flyctl 没有 per-process-group secret（验过 0.4.48），fly 上 chat 进程实际能看到 master credentials。`chat/asgi.py` 的 boot fail-fast 已注释掉、`scripts/sync_fly_secrets.py` 退化成 app-level 整体推（详见 script docstring 和 `chat/asgi.py` 文件头）。下一次 web/chat 拆成两个独立 fly app 时再启用运行时防线。
- **静态防线（仍生效）**：ruff `flake8-tidy-imports.banned-api` 禁止 `pinai_agents.web` ↔ `pinai_agents.chat` 互相 import；CI 跑 `scripts/check_trust_boundary.sh` 兜底 grep 检查方向性；共享类型放 `pinai_agents.shared/`（纯 model / protocol）。改动 trust boundary 前必读 `chat/trust_boundary.py` 的 docstring。

## 环境拓扑

| 环境 | pinai-agents (web+chat) | Frontend | Web (zebra) | Internal reward dashboard | LiteLLM |
|------|--------------------------|----------|-------------|---------------------------|---------|
| dev | `proactive-ai-agents-dev` | `proactive-ai-frontend-dev` | `proactive-ai-web-dev` | `proactive-ai-reward-dashboard-dev` | `proactive-ai-litellm-dev` |
| test | `proactive-ai-agents-test` | `proactive-ai-frontend-test` | 暂无（CI 跳过） | 暂无独立 app | `proactive-ai-litellm-test` |
| prod | `proactive-ai-agents-prod` | `proactive-ai-frontend-prod` | `proactive-ai-web-prod` | 暂无独立 app | `proactive-ai-litellm-prod` |

所有 fly app 都在 `iad` / `ord` region。Daytona sandbox 是 chat 进程的远端执行环境（python_exec、browser tool 跑在那里），不算 fly app。

上表是 fly app 维度（表中 Frontend 列 = proactive-ai-frontend 的 web/nginx 形态）。**apps/desktop**（Electron 桌面）、**apps/mobile**（Expo RN）、**proactive-ai-frontend 的 iOS** 都不是 fly app，部署形态见「变更与部署」。

## Secrets 管理（dotenvx）
所有环境变量（后端 secrets + 前端 VITE_*）用 [dotenvx](https://dotenvx.com/) 加密 checkin，每环境一把私钥。

```
pinai-agents/.env.dev / .env.test / .env.production       # 后端 + VITE_* 加密真源（已 checkin）
ops/litellm/.env.dev / .env.test / .env.production        # LiteLLM 加密真源
./.env.dev                                                # 根：NGROK_AUTHTOKEN 加密真源（复用 DEV keypair，已 checkin）
pinai-agents/.env.keys / ops/litellm/.env.keys            # 私钥文件，不 checkin；或用 DOTENV_PRIVATE_KEY_* env var（~/.zshrc），二选一
pinai-agents/.env / pinai-agents/.env.chat / ops/litellm/.env / ./.env  # 本地明文，make ensure-env 自动生成，不要手改、不要 commit
```

`.env.chat` 是 `make ensure-env-pinai-agents` 从 `.env` 派生出来的——把 `FORBIDDEN_ENVS` 列出的 master credentials 剔掉，专给本地 `pinai-chat` 容器用。dotenvx CLI 用法见 [dotenvx 官方文档](https://dotenvx.com/)；Fly secret 同步看 `pinai-agents/scripts/sync_fly_secrets.py`；CI secrets 注入看 `.github/workflows/deploy-{dev,test,prod}.yml`。

**Supabase API key 命名**（统一用 Supabase 当前命名，**禁止**用 legacy 名字 `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`）：
- `VITE_SUPABASE_PUBLISHABLE_KEY`（公开 `sb_publishable_*`）— 前端 + 后端 verify JWT 共用同一值。后端可读这个 env，或单独设 `SUPABASE_PUBLISHABLE_KEY`，两者等价。
- `SUPABASE_SECRET_KEY`（私 `sb_secret_*`）— web 进程 master credential。用于 Supabase Storage 写入、`/auth/v1/admin/users/{id}` 等绕 RLS 的 admin 调用。**禁止**进 chat 进程。
- 从 Supabase dashboard 拿：Project Settings → API Keys 页面。Legacy "Anon / service_role" tab 不要用。

## 高频目录
- `pinai-agents/src/pinai_agents/config.py`：pydantic-settings 配置中心，所有 env 读取从这里走。
- `pinai-agents/src/pinai_agents/web/`：web 进程（FastAPI app + auth + Composio + device ingest + payment + scheduler + storage + LiteLLM key 管理）。入口 `web/app.py` / `web/asgi.py`。
- `pinai-agents/src/pinai_agents/web/routes/`：HTTP 路由（`agent/` = JWT 鉴权的内部 API，`ui/` = 前端面向的控制面接口）。
- `pinai-agents/src/pinai_agents/web/db/repositories/`：Supabase / pai_* schema 的数据访问层。
- `pinai-agents/src/pinai_agents/chat/`：chat 进程（LLM loop + DeepAgents harness + Daytona sandbox）。入口 `chat/app.py` / `chat/asgi.py`。
- `pinai-agents/src/pinai_agents/chat/routes/`：`chat.py`、`generate.py`、`history.py`、`run.py`。
- `pinai-agents/src/pinai_agents/chat/agents/`：generator / chat / dream / crystallize 等 agent 实现。
- `pinai-agents/src/pinai_agents/chat/tools/` + `chat/browser/`：sandbox 工具（python_exec、browser via Browserbase）。
- `pinai-agents/src/pinai_agents/shared/`：web/chat 共用的 pure model / protocol（SSE envelope、api models），不能 import web 或 chat。
- `pinai-agents/packages/pinai_sdk/`：Daytona sandbox 内部用的 Python SDK，sandbox 里通过 `PAI_API_URL` 回连 web。
- `pinai-agents/db/migrations/`：yoyo 风格 SQL migration，命名 `NNN_<topic>.sql`（触碰 pai schema 的表习惯加 `pai_` 前缀，如 `015_pai_background_tasks.sql`）。
- `pinai-agents/db/ingest_recipes/`：connector ingest 的 declarative recipes。
- `pinai-agents/infra/daytona/`：Daytona snapshot 构建脚本。
- `pinai-agents/scripts/`：`sync_fly_secrets.py`（trust boundary 守护）、`regen_sdk.py`、`check_trust_boundary.sh`、`validate_ingest_recipe.py`。
- `packages/core/src/`、`packages/state/src/`：跨端纯逻辑层（`@pin-ai/core`=transport/SSE/API/域类型/状态机/ports；`@pin-ai/state`=TanStack Query/zustand/编排 hooks），平台无关，边界由根 eslint 强制。
- `packages/design/`：跨端设计 token SSOT（`@pin-ai/design`，`tokens.cjs/mjs/json`，web Tailwind + RN NativeWind 共用）。
- `packages/ui-kit/src/`：双端设计系统层（`@pin-ai/ui-kit`，`cn` / 组件契约 / cva / motion 预设），平台无关，web 与 RN 共享。
- `packages/ui-web/src/`：web 介质共享层（`@pin-ai/ui-web`：auth/聊天栈/球面/卡片/connect/voice/browser/设置 sections），proactive-ai-frontend 与 apps/web 双端消费，硬标准「纯 web 可运行」，重 native 模块经注册点注入（registerSignOutCleanup / registerFeedbackOutbox / registerLocalThreadStore / registerExternalMicAcquirer）。
- `proactive-ai-frontend/src/`：Capacitor React SPA（Vite + Tailwind，Web/iOS/Android），**当前生产 iOS 前端**，经 vite alias 直引 packages 共享层。
- `apps/web/src/`：zebra 桌面 web 端（独立 Vite app；壳=ZebraShell/panels/⌘K，功能=共享层）。已上线 dev/prod（部署见「变更与部署」）。
- `apps/desktop/src/`：Electron macOS 壳（`main` + `preload`；renderer 复用 apps/web，见 `electron.vite.config.ts`）。本地 `make macos`，暂无自动部署。
- `apps/mobile/src/`：Expo / React Native iOS app（UI 独立实现，消费 core/design/state/ui-kit；native 采集在 `apps/mobile/modules/`）。开发中、未上线；本地 `make rn`。
- `research/2026-06-10-frontend-layering.mdx`：前端分层 SSOT（core/state/apps 三层，web/Electron/RN 三端）。
- `internal-reward-dashboard/src/`：内部 reward review app（`/runs`、`/cards/:cardId`、`/casebook`、`/traces/:runId`、`/personal-data`），本地端口 `3004`，不要混进主产品前端。
- `ops/litellm/`：LiteLLM 配置 + fly toml + 部署脚本。

## 文档读取规则（AI 必读）
`docs/` 是团队开发和 AI agent 查询的统一上下文。读取顺序必须渐进式展开：

1. 先读 [`docs/index.mdx`](docs/index.mdx)，确认该任务属于哪个模块。
2. 再读相关的 `docs/modules/*.mdx`。模块文档是当前事实，改代码前以它为准。
3. 只有当模块文档底部出现 `相关 AI Plans`，或任务明确涉及对应设计取舍时，才继续读 `docs/plans/*.mdx`。
4. 不要把 `docs/plans/` 当历史归档。plan 只是可引用的 AI 设计计划，不替代模块文档。
5. 如果代码行为和文档冲突，以代码核实当前事实，并同步更新对应模块文档。

> ⚠️ 部分 `docs/modules/*.mdx` 还残留 `apis/` / `pinai-openclaw/` 时代的描述，和 `pinai-agents/` 实际代码冲突时以代码为准，并顺手更新该模块文档。后端搬迁的设计 SSOT 在 [`docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx`](docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx)。

## 文档维护规则
- `docs/modules/*.mdx`：每个模块一篇当前事实文档，必须包含边界、核心链路、开发入口、验证方式、踩坑。
- `docs/plans/*.mdx`：只保留仍然能解释当前设计的 AI plans 或正在 brainstorm 的设计草稿。
- 新增 plan 的默认路径是 `docs/plans/YYYY-MM-DD-<topic>.mdx`；长期架构计划可以使用稳定 slug。
- 新增 plan 后必须在 `docs/plans/README.mdx` 表格里登记一行（标状态：brainstorm 草稿 / 已定稿）。
- plan 推荐被模块文档的 `相关 AI Plans` 引用；brainstorm 草稿可以先只挂在 `plans/README` 索引上。
- plan 必须等到**对应实现已上线、模块文档已完整吸收设计要点**后，才能删除并从 README 索引移除，不新建 archive。设计阶段或实现进行中的 plan 一律保留。
- Mintlify 侧边栏只放 `docs/index.mdx` + `docs/modules/*.mdx` + `docs/plans/README.mdx`（AI Plans 索引）；具体 plan 不进侧边栏，通过索引或模块页 `相关 AI Plans` 跳转。

## 当前模块文档
- [`docs/modules/data-connectors.mdx`](docs/modules/data-connectors.mdx) — Composio、device registry、mobile ingest、连接状态矩阵。
- [`docs/modules/memory.mdx`](docs/modules/memory.mdx) — `pai_raw_*` / personal_signals / world_signals / memory / profile / skill / evolution。**改动 memory / profile / skill / signals / evolution_runs / raw schema 相关代码前必读**。
- [`docs/modules/generation.mdx`](docs/modules/generation.mdx) — `/generate`、pipeline、unified generator、evaluation、card selection、auto-generate。
- [`docs/modules/execution.mdx`](docs/modules/execution.mdx) — chat-stream、card chat、agent prompt、browser tool、control mode、conversation crystallize。**改动 chat/routes / chat/agents / chat/browser / 前端 MainChatView 相关代码前必读**。
- [`docs/modules/feedback.mdx`](docs/modules/feedback.mdx) — feedback events、card action、card chat feedback、intent state、学习回流。
- [`docs/modules/internal-reward-dashboard.mdx`](docs/modules/internal-reward-dashboard.mdx) — 内部卡片 review Vite app、reward ledger、reviewer score、casebook、LangSmith trace artifact。**改动 `internal-reward-dashboard/`、`/api/reward-dashboard/*`、`pai_card_reward_events` / `pai_card_casebook` / `pai_trace_artifacts` 前必读**。
- [`docs/modules/background-tasks.mdx`](docs/modules/background-tasks.mdx) — `background_tasks` 队列、scheduler tick、reconciler、connector init/sync/evolve、auto-dreaming。
- [`docs/modules/runtime-deployment.mdx`](docs/modules/runtime-deployment.mdx) — 本地启动、运行拓扑、部署、安全、billing 概览。**当前文档仍是 apis/openclaw 时代的描述，待按 pinai-agents 重写**；在那之前，运行/部署的事实以本 AGENTS.md「本地开发」「变更与部署」两节为准。

## 本地开发

首次设置：
```bash
cd pinai-agents && uv sync && cd -
npm install                # root workspace 安装 proactive-ai-frontend + capacitor-plugins；iOS SPM 路径依赖这里的 node_modules
cd internal-reward-dashboard && npm install && cd -
# 找团队成员获取 dotenvx 私钥，放进 ~/.zshrc（一把 DEV 私钥解密所有 .env.dev）：
#   export DOTENV_PRIVATE_KEY_DEV=...
# （或老办法：把 .env.keys 文件放到 pinai-agents/ 和 ops/litellm/，二选一）
make up                    # 自动解密 .env.dev → .env，构建并启动所有服务
```

全栈启动（Docker Compose）：
```bash
make up                    # 启动 postgres + litellm + pinai-web + pinai-chat + frontend + web(zebra)
make logs                  # 跟所有 log
make logs-pinai-web        # 单看 web
make logs-pinai-chat       # 单看 chat
make restart               # 改了 pinai-agents 代码后重建 web+chat
make restart-frontend      # 改了前端代码（容器版本）
make reset                 # 清空数据从头来（数据会丢失）
make status                # 查看容器状态
make urls                  # 看本 group 的随机 host 端口 + ngrok URL
```

多 worktree 并行：每个 worktree 起独立 docker group（`COMPOSE_PROJECT_NAME=pinai-<worktree 路径 hash>`，容器/网络/卷/端口自动隔离），可同时 `make up` 互不撞。
- host 端口**随机**（不再固定 8000/3000/54322），`make urls` 看本 group 实际端口；浏览器 web 测试走各自 localhost，**不需要 ngrok**（same-origin + 容器内 nginx 反代到 `pinai-web:8000`）。
- 容器**无固定名**，进容器/看日志用 `docker compose exec <service>` / `docker compose logs <service>`，**不要** `docker exec pin-ai-xxx`。
- 多 worktree 共享 Docker Desktop 内存：litellm 已调瘦到 1 worker + 1.5g cap，每 group ~1.25GB，7.65GB 能并行 ~6 个。

轻量开发（不走 Docker）：
```bash
cd pinai-agents && uv sync                          # 装 Python 依赖
cd pinai-agents && uv run uvicorn pinai_agents.web.asgi:app --reload --port 8000
cd pinai-agents && uv run uvicorn pinai_agents.chat.asgi:app --reload --port 8001
cd proactive-ai-frontend && npm run dev             # 前端 dev server（端口 3003）
cd apps/web && npm run dev                          # zebra 桌面 web dev server（端口 3005）
cd internal-reward-dashboard && npm run dev -- --host 127.0.0.1 --port 3004  # 内部 review app
```

`internal-reward-dashboard` 本地通过 Vite same-origin `/api/*` proxy 打 `pinai-web:8000`，默认从 `pinai-agents/.env` 读取 Supabase `VITE_*`。它当前不是 root npm workspace；dev 环境是独立 Fly app `proactive-ai-reward-dashboard-dev`，不是 `proactive-ai-frontend` 部署产物。

Daytona sandbox（generator/dreaming 的 `python_exec`）和 mobile 真机需要公网回连 `pinai-web`。`NGROK_AUTHTOKEN` 已加密 checkin 在根 `./.env.dev`（`make ensure-env` 自动解密）；ngrok 给每个 worktree 一个**稳定子域** `https://<project-name>.ngrok.app`（compose 用 `--url=https://${COMPOSE_PROJECT_NAME}.ngrok.app`，付费版特性）。**`make up` 不自动起 tunnel**（web 测试不需要，也省 ngrok endpoint hours）；需要时显式起：
```bash
make tunnel-up             # 起 ngrok（随机 URL）+ 把 URL 注入 pinai-chat（generator 用）
make tunnel-status         # 看当前 URL
make tunnel-down
```
每个 worktree 用自己的 `.ngrok.app` 子域（= project hash），所以 **多 worktree、多人共享同一个 token 可以并发各起 tunnel，互不冲突**（各拿各的 URL）。前提是**付费 ngrok**——免费版只能用账户那一个 dev domain，多开会 ERR_NGROK_334；付费版才能用任意 `<name>.ngrok.app` 子域。

Mobile（Capacitor，iOS / Android — proactive-ai-frontend 路线）：
```bash
make ios                   # 默认：自动起本 worktree tunnel + 抓 URL → 构建前端 → cap sync → 打开 Xcode
make android               # 同上，装到 USB device
```
`make ios` / `make android` 默认会**自带起本 worktree 的 ngrok tunnel**，把随机 URL bake 进 build —— 在哪个 worktree 跑就连那个 worktree 的后端（一台手机一次一个 worktree）。后端切换：`NGROK=<url>` 走指定公网、`DEV=1` 指 fly dev、`PROD=1` 指 fly prod（这三者跳过本地 tunnel）。

iOS 多环境与签名硬规则：
- **dev/prod 双 app 是设计内的多环境**：dev = bundle id `ai.pin.proactive.development`（显示名「PIN AI Dev」），prod = `ai.pin.proactive`（「PIN AI」），各走自己的 distribution profile，可同设备并存。bundle id / 显示名 / OAuth scheme 由 CI `proactive-ai-frontend/scripts/build-ios.sh <dev|prod>` 注入（archive 时 build-setting override + ExportOptions per-env + `VITE_OAUTH_SCHEME` bake 进 JS），不手改 Xcode。dev 走 push 自动构建上传 TestFlight、prod 手动 dispatch。本地 `make ios`（Xcode 直接 build）不经 CI 注入，用工程 checkin 的默认值 = dev 同款：显示名「PIN AI Dev」、bundle id `ai.pin.proactive.development`——本地 build 和 dev TestFlight 同 id、同设备互相覆盖，prod 不受影响。本地默认 OAuth scheme 在 `sync-ios.sh` 里写死为同一 dev id（CI 总是显式覆盖），改工程默认 bundle id 必须同步它。push：dev 的 `APNS_BUNDLE_ID=ai.pin.proactive.development` + `APNS_USE_SANDBOX=false`（production endpoint）服务 TestFlight 形态；本地 Xcode build 是 development 签名（sandbox token），收不到 dev/local 后端的 push，这与 bundle id 无关。
- **禁止为绕过问题临时换 id**：不要为了绕过签名失败、权限/能力不满足、验证报错而新增或改 bundle id / 包名 / scheme / target。signing/profile 不满足时停下来报告真实 blocker，不要换 id 绕过。
- 同一环境内的安装是用该环境原 bundle id 覆盖更新，不要为并存再造这两个之外的第三个 id。

桌面（Electron，apps/desktop）与 RN（Expo，apps/mobile）各自独立 build，不走 Capacitor：
```bash
make macos                 # Electron 桌面壳（renderer 复用 apps/web）连本 worktree 后端；DEV=1 fly dev、PROD=1 fly prod
make rn                    # Expo RN 装真机 iPhone；SIM=1 模拟器、DEV=1 fly dev、PROD=1 fly prod、TUNNEL=1 Metro 走 ngrok
```
`make macos` = `npm run dev --workspace=@pin-ai/desktop`（electron-vite，`/api` 同源 proxy 到 pinai-web，与 web dev 同构零 CORS）。`make rn` 先 `expo prebuild` 生成 `ios/`（gitignore 产物）再 `expo run:ios`，把 `VITE_*` 映射成 `EXPO_PUBLIC_*`。**apps/mobile 仍在开发、未上线**；apps/desktop 仅本地运行，打包（`npm run package --workspace=@pin-ai/desktop` 出 dmg）的签名/公证未配。

验证：
```bash
cd pinai-agents && uv run ruff check               # 静态检查（含 trust-boundary 防墙）
cd pinai-agents && uv run mypy src                 # 类型检查（CI 硬门禁；增量缓存，重复跑只几秒）
cd pinai-agents && uv run pytest                   # 后端测试
cd proactive-ai-frontend && npm run type-check     # 前端类型检查
cd proactive-ai-frontend && npm test               # 前端单测（vitest）
cd internal-reward-dashboard && npm run type-check  # 内部 review app 类型检查
cd internal-reward-dashboard && npm test            # 内部 review app 单测
cd apps/web && npm run type-check && npm test       # zebra web 端
cd apps/desktop && npm run type-check               # Electron 桌面壳（仅类型）
cd apps/mobile && npm run type-check                # Expo RN（仅类型）
npm run check:packages                              # core/state/ui-kit/ui-web 边界 lint + 类型 + 单测
```

改完怎么验证（按改动范围选最轻的）：
- 纯 Python 逻辑/类型 → `uv run ruff check` + `uv run mypy src` + 相关 `uv run pytest tests/<path>`
- 改 `pinai-agents/src/pinai_agents/web/` → `make restart`，看 `make logs-pinai-web` 起得来 + 打目标接口（端口随机，`make urls` 查）
- 改 `pinai-agents/src/pinai_agents/chat/` → `make restart`，看 `make logs-pinai-chat` + 用前端发一条消息验证
- 改 proactive-ai-frontend → `npm run dev`（端口 3003）在浏览器点；或 `make restart-frontend` 看容器版本
- 改 `apps/web/` → `cd apps/web && npm run dev`（端口 3005）+ `cd apps/web && npm run type-check && npm test`
- 改 `apps/desktop/` → `cd apps/desktop && npm run type-check` + `make macos` 看 Electron 起得来
- 改 `apps/mobile/` → `cd apps/mobile && npm run type-check` + `make rn SIM=1` 在模拟器点
- 改 `packages/`（共享层）→ `npm run check:packages`（core/state/ui-kit/ui-web 边界+类型+单测）；这些包被多端共享，按改动面补跑消费端 type-check（proactive-ai-frontend / apps/web 另跑单测，desktop / mobile 只有 type-check）
- 改 `internal-reward-dashboard/` → `npm run type-check` + `npm test` + `npm run dev -- --host 127.0.0.1 --port 3004`，在 `/runs` / `/traces/:runId` 点真实流程
- 改 `/api/reward-dashboard/*` 或 reward schema → `uv run ruff check .` + `uv run pytest tests/web/db/repositories/test_reward_repo.py tests/web/routes/test_reward_dashboard.py tests/web/services/test_trace_artifacts.py`
- 改 db migration（新 SQL 文件到 `db/migrations/`）→ 先 `make build-pinai-agents` **再** `make migrate`，确认 schema 应用成功。⚠️ 迁移 SQL 被烘焙进镜像（Dockerfile `COPY db`），只跑 `make migrate` 不重建镜像会执行**旧** SQL、悄悄忽略新文件（仍显示「db-migrate complete」但表没建出来）
- 动 Daytona sandbox / pinai_sdk → `make tunnel-up` + 跑一次 generate，观察 sandbox 是否能回连 web

**测试-修复 loop 边界**：失败先看 log 找根因再改，**最多 2 轮**仍不通就停下来，把现象、已尝试的修复、当前怀疑点报给 user，不要继续硬改。

**docker healthy ≠ 功能对**：本地容器起来只是"代码能站起来"。依赖 Supabase token / 真实用户数据 / Stripe webhook / Composio OAuth 的链路本地验不出来，如实声明"本地只验证启动 + 类型"，不要把容器 healthy 当通过。

**测试用空库可以 mock 数据**：本地 DB 里 personal_signals / memory / cards / feedback 等表为空时，链路跑不到要测的分支。可以临时插一批最小可用的 mock 行（同一 user_id + 必要的 status / created_at 字段）把测试跑通，但要做到：(1) 仅本地/dev，禁止灌 prod；(2) mock 数据用可识别的 marker（比如 `note='__mock__'` 或固定前缀 id）方便清理；(3) 测完清掉，不要留在共享 dev DB 里污染别人。优先用脚本（`pinai-agents/scripts/` 下加一次性 seed）而不是手敲 SQL。

**不用担心 LLM token 或 Daytona 计费**：测试时直接跑就行，不要为了"省调用"刻意缩小用例、跳过链路、或者改成 mock。该真跑就真跑。

完整命令：`make help`

## Tracing 调试（LangSmith）
agent 链路（chat / generator / dreaming / crystallize 等）通过 LangChain 自动上报到 [LangSmith](https://docs.langchain.com/langsmith)。要 debug prompt、工具调用、token、错误时，用 LangSmith CLI 直接拉 trace，不用打开 web UI。

安装（一次性，已装可跳过）：
```bash
curl -fsSL https://cli.langsmith.com/install.sh | sh   # 装到 ~/.local/bin/langsmith
langsmith self-update                                  # 升级
```

`LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` 已在 `pinai-agents/.env`（dotenvx 解密自 `.env.dev`，dev project 是 `pinai-agents-dev`）。本地用之前 source 一下：
```bash
set -a && . pinai-agents/.env && set +a
```

常用命令：
```bash
langsmith project list                                            # 看有哪些 tracing project
langsmith trace list --project pinai-agents-dev --format pretty   # 拉最近的 trace
langsmith run list --project pinai-agents-dev --run-type llm      # 看 LLM 调用
langsmith thread list --project pinai-agents-dev                  # chat 按 thread 查
```
默认 JSON 输出（方便 grep / jq），加 `--format pretty` 看表格。完整文档：<https://docs.langchain.com/langsmith/langsmith-cli>。

## Sandbox 调试（Daytona）
chat 进程的 `python_exec` / browser 等工具跑在 [Daytona](https://www.daytona.io/docs/) cloud sandbox 里。要查 sandbox 状态、看快照、远程跑命令时，用 Daytona CLI，不用打开 web 控制台。

安装（任选一种，已装可跳过）：
```bash
brew install daytonaio/cli/daytona                                            # 官方推荐
# 或下载 darwin-arm64 binary 到 ~/.local/bin/daytona（brew 装不上时的 fallback）
curl -fsSL -o ~/.local/bin/daytona https://github.com/daytonaio/daytona/releases/latest/download/daytona-darwin-arm64 && chmod +x ~/.local/bin/daytona
```

`DAYTONA_API_KEY` 在 `pinai-agents/.env`（dotenvx 解密自 `.env.dev`）。首次需要写入本地 profile：
```bash
set -a && . pinai-agents/.env && set +a
daytona login --api-key "$DAYTONA_API_KEY"   # 一次性，profile 存到 ~/.daytona
```

常用命令：
```bash
daytona list                        # 列出所有 sandbox（id / 状态 / region / 最近活动）
daytona info <sandbox-id>           # 看单个 sandbox 详情（资源、镜像、env）
daytona exec <sandbox-id> -- <cmd>  # 在 sandbox 里直接跑命令
daytona snapshot list               # 看可用快照（chat/generate 默认 fork 自这里）
```
注意：`organization` 子命令在 API key auth 下不可用（CLI 会要求改用浏览器登录）。完整文档：<https://www.daytona.io/docs/en/tools/cli/>。

Snapshot 构建脚本在 `pinai-agents/infra/daytona/`，CI（`deploy-test.yml` 的 `build-daytona-snapshot` job）在每次部署前会刷新 snapshot，本地需要手动 rebuild 时跑那个目录下的脚本。

## 变更与部署

**分支模型**：`main` 是唯一长期主干，受 ruleset 保护——**禁止直接 push**，所有改动走 PR + CI gate（`pinai-agents-checks` / `frontend-check` 必须绿）才能 merge。功能分支从 `main` 切、PR base 填 `main`。老 `main` 已归档为 `main-legacy`。

### Dev 环境
push 到 `main` 后按改动范围自动部署（CI workflow：`.github/workflows/deploy-dev.yml` → 复用 `_deploy.yml`）：
- 改 `pinai-agents/` 或 `proactive-ai-frontend/` → 部署 pinai-agents + 前端
- 改 `apps/web/` 或 `packages/`（共用层）→ 部署 apps/web（zebra）；改 `packages/` 同时触发前端重部署
- 改 `ops/litellm/` → 部署 LiteLLM
- Daytona snapshot 跟随 pinai-agents 部署刷新

`apps/web`（zebra 桌面 web 端）与前端走**同一套统一部署管道**（`_deploy.yml` 的 `deploy-web` job + `web_toml` input），dev 跟 main push、prod 跟 `v*` tag——和前端机制完全一致。test 环境暂不部署 web（caller 不传 `web_toml`，job 自动跳过）；PR 上四端（proactive-ai-frontend / apps/web / apps/desktop / apps/mobile）的 type-check + packages 边界 lint/类型/单测，统一由 `ci.yml` 的 frontend-check 覆盖。

**apps/desktop（Electron）和 apps/mobile（Expo RN）只进 CI type-check，没有自动部署。** desktop 目前仅本地 `make macos`，electron-builder 打包/签名/公证待做；mobile 的 `build-rn-ios.yml` 自动触发已注释禁用（RN iOS 链路未就绪），只能手动 `workflow_dispatch` archive → TestFlight。**proactive-ai-frontend 的 iOS** 另走 `build-ios.yml`：push main（命中 `proactive-ai-frontend/` / `capacitor-plugins/` / `packages/`）自动 build dev → TestFlight，prod 手动 dispatch（bundle id dev=`ai.pin.proactive.development`、prod=`ai.pin.proactive`）。

`internal-reward-dashboard/` 使用独立 workflow `.github/workflows/internal-reward-dashboard-dev.yml`：PR 只跑 type-check / test / build；push 到 `main` 且该目录变化时，部署到 Fly dev app `proactive-ai-reward-dashboard-dev`（默认地址 `https://proactive-ai-reward-dashboard-dev.fly.dev`）。

### Test 环境
GitHub Actions 页面手动触发 **Deploy Test**（`deploy-test.yml`）。可以从任意分支部署，用来在合并前在 fly 上跑一次完整链路。

### Prod 环境
push `v*` tag 自动触发 **Deploy Prod**（tag = 版本真相），也可在 GitHub Actions 页面手动触发（选 `main` 分支）。production environment 靠 branch/tag policy（放行 `v*` tag + `main`）gate；人工审批暂未启用，后续再加。

发版用 `scripts/release.sh v0.1.0`：脚本校验在 main + 工作区干净 + 与 origin/main 一致后，打 `v*` annotated tag 并 push，自动触发上面的 Deploy Prod。

### 本地部署（备用）
CI/CD 不可用时走 Makefile：
```bash
make deploy-pinai-dev       # pinai-agents (web + chat) → dev
make deploy-pinai-prod      # pinai-agents → prod
make deploy-frontend-dev    # 前端 → dev
make deploy-frontend-prod   # 前端 → prod
make deploy-reward-dashboard-dev  # 内部 reward dashboard → dev
make deploy-web-dev         # apps/web (zebra) → dev
make deploy-web-prod        # apps/web (zebra) → prod
make deploy-litellm-dev     # LiteLLM → dev
make deploy-litellm-prod    # LiteLLM → prod
```
所有 deploy 命令已内置 `env -u all_proxy -u http_proxy -u https_proxy`，避开本机全局代理导致的 flyctl 失败。命令细节看 `Makefile` 对应 target。

## 生产环境硬性规则
- 生产部署优先走 GitHub Actions（有审计日志；人工审批暂未启用，后续再加）。
- 生产环境禁止直接执行任何数据库变更，migration 必须随部署自动跑。
- 所有生产变更必须走代码评审 + CI/CD。
- Fly secrets 通过 `pinai-agents/scripts/sync_fly_secrets.py` 同步，**不要**手动 `flyctl secrets set` 单 key，否则会绕过 trust boundary。

## 安全约束（P0）
- **Trust boundary**：master credentials（`SUPABASE_SECRET_KEY` / `PAI_JWT_SIGNING_KEY` / `COMPOSIO_API_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `LITELLM_MASTER_KEY`）禁止进入 chat 进程环境。单一真源在 `pinai-agents/src/pinai_agents/chat/trust_boundary.py` 的 `FORBIDDEN_ENVS`；改动 chat secret 注入相关代码后必须确认 `chat/asgi.py` 的 boot fail-fast、Makefile `.env.chat` 派生、`pinai-agents/scripts/sync_fly_secrets.py` 三道防线都还在。
- **Composio 写命令受控**：read/query 类 Composio tool 默认可执行；有副作用的 tool 只有代码 allowlist 内的 `GMAIL_CREATE_EMAIL_DRAFT` / `GMAIL_SEND_DRAFT` 可执行，且必须显式传 side-effect 同意标记。不要指导 agent 用 `GMAIL_SEND_EMAIL` 或 allowlist 外任意 create/update/delete/send tool。
- **JWT 签名隔离**：web 用 Ed25519 私钥签 per-run agent JWT；chat 只持 Ed25519 公钥验签（chat 侧泄露也无法伪造新 token，这是相对 HS256 对称密钥的核心安全升级）。私钥永远只在 web 进程。
- **dotenvx 私钥**（`.env.keys`）禁止 checkin，找团队成员获取。
- **用户标识规约**：`users.id` (BIGINT) 仅用于 DB 内部 FK / RLS / `user_scoped_tx` / 内部 JWT 的 `user_id` claim，**永远不出本系统**——BIGSERIAL 在本地 docker / dev fly / prod fly 是独立序列，跨环境必撞。任何对外 namespace（Composio user_id、LiteLLM user_id / key_alias、Supabase Storage path prefix、Stripe metadata 主键、其它第三方 SaaS）必须用 `users.supabase_user_id` (UUID NOT NULL，全球唯一、Supabase 不复用、跨环境一致)。

## 数据库变更规则
- 每次 schema 变更写新的 migration 文件到 `pinai-agents/db/migrations/`，命名 `NNN_<topic>.sql`；触碰 pai schema 的表习惯加 `pai_` 前缀（例如 `015_pai_background_tasks.sql`），其余按 topic 描述即可（例如 `001_users.sql` / `030_drop_legacy_user_columns.sql`）。
- migration 文件一旦 merge 到 main，禁止修改。
- migration 只做 additive（加表、加列）；删列/改列走 expand-contract，分两个 release。
- migration 用 **yoyo**（pure SQL，forward-only），配置在 `pinai-agents/yoyo.ini`，table 是 `pai_yoyo_migration_log`。
- dev/test/prod 部署时通过 fly `release_command` 自动跑 `yoyo apply`；本地 `make migrate` 一次性跑完（包括建 litellm database）。**禁止手动连 prod DB 跑 SQL。**
- RLS 策略在 `023_pai_rls.sql`，新增表如果涉及用户数据必须同时加 RLS policy。

## 踩坑速查
1. **chat 进程拿到 master credential 会启动失败**：`chat/asgi.py` 的 fail-fast assert 会直接 exit，看 log 第一行就能定位是哪个 forbidden var 漏过来了。
2. **Daytona sandbox 回连 web 必须用公网 URL**：compose 内部 DNS 在 cloud sandbox 里解析不到，本地必须 `make tunnel-up` 起 ngrok，否则 `python_exec` 报 ConnectError。
3. **`make restart` 只重建 pinai-web/pinai-chat**：动了 frontend 用 `make restart-frontend`，动了 LiteLLM 配置要 `make up` 全栈。restart 带 `--no-deps`，**不会创建合并 main 后 compose 新增的服务**（例：redis）——拉完 main 先 `make up` 一次再回到 restart 循环，否则新代码会依赖一个根本没起来的服务（实例：缺 redis 时消息无人消费、会话页 500，2026-06-10 踩过）。
4. **本机全局代理会导致 `flyctl` 失败**：Makefile 已在 deploy 命令内置 `env -u`，但如果直接跑 `flyctl deploy` 要自己 unset。
5. **`.env.chat` 不会自动跟 `.env` 同步**：手动改 `.env` 后，`make ensure-env-pinai-agents` 才会重新派生 `.env.chat`；直接 docker compose up 不会触发，必要时 `make env-local` 强制重新解密。
6. **`apis/` / `pinai-openclaw/` / `miniapp/` 是退役时代的路径**：如果旧脚本、旧文档或本地残留目录提到它们，不要复活旧服务；当前后端事实以 `pinai-agents/` 为准，用户产品前端类型检查走 `cd proactive-ai-frontend && npm run type-check`。
7. **`internal-reward-dashboard/` 是独立内部工具**：不要把 dashboard 页面放进 `proactive-ai-frontend/src/`，不要把 `/api/reward-dashboard/*` 当普通用户产品 API 扩散。用户 confirm / dismiss / snooze / text feedback 仍写 `pai_feedback_events`，只有 card open / score / reviewer score / casebook / trace 走 reward dashboard 链路。
8. **容器无固定名（多 worktree 隔离）**：compose 去掉了 `container_name`，每个 worktree 是独立 group（`pinai-<路径hash>`，可同时 `make up` 互不撞）。旧的 `docker exec pin-ai-xxx` 全失效，改用 `docker compose exec <service>` / `docker compose logs <service>`（在对应 worktree 目录跑，自动命中那个 group）。host 端口随机，`make urls` 查；`make up` 不自动起 tunnel，generator/mobile 要 tunnel 时 `make tunnel-up` / `make ios`（各 worktree 自己的 `.ngrok.app` 子域，可并发，付费版）。

## 提交规范
- Conventional Commits：`feat(...)` / `fix(...)` / `chore(...)` / `docs(...)`。
- 每次提交聚焦一个变更点。
- 提交前最少跑：`cd pinai-agents && uv run ruff check && uv run mypy src`（改 Python）+ 前端按改动面：动 `packages/` 跑 `npm run check:packages`，动某个端跑该端 `npm run type-check`（proactive-ai-frontend / apps/web 另跑 `npm test`）。

## 规则单一真源
- `AGENTS.md` 是 SSOT。
- `CLAUDE.md`、`GEMINI.md`、`.cursor/rules/agents.mdc` 均指向本文件。
- 未经允许不要乱加 fallback。
- 请使用平实、直接、克制的技术白话中文。禁止大厂黑话（赋能、闭环、底座、抓手等）。多用精确工程术语，从具体事实说起。
