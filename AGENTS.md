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

Proactive AI 后端整体收敛到 **pinai-agents**（Python / FastAPI / LangChain + DeepAgents），用户产品前端是 **proactive-ai-frontend**（React SPA，Vite + Tailwind + Capacitor，登录走 Supabase Auth），内部卡片 review 工具是 **internal-reward-dashboard**（独立 Vite React app，登录也走 Supabase Auth）。LLM 统一经 **LiteLLM** 路由。

`apis/`（Node 后端 + 容器编排 + gateway）、`pinai-openclaw/`（用户容器镜像 + plugin）、`miniapp/`（Telegram mini app）三个老仓目录已经移除，所有职责都搬到 pinai-agents：

- 控制面（auth / device / connector / payment / scheduler / migrations）→ `pinai-agents` 的 **web 进程**。
- LLM 链路（chat / generate / dreaming agents + Daytona sandbox 工具）→ `pinai-agents` 的 **chat 进程**。
- 两个进程共用一个 fly app（`[processes]` 切分），共用一份镜像。
- 用户级 OpenClaw 容器和 gateway 代理整套都退役了，前端直接打 pinai-agents HTTP/SSE。

## 进程信任边界（web vs chat）

pinai-agents 在同一 codebase 里跑两个进程，**单一信任边界**：

- **web 进程**：持 master credentials（`SUPABASE_SECRET_KEY` / `PAI_JWT_SIGNING_KEY` / `COMPOSIO_API_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `LITELLM_MASTER_KEY`）。负责签 JWT、mint LiteLLM virtual key、写入 Supabase Storage、调 Supabase Auth admin API、跑 Composio ingest 等"代表用户"的动作。
- **chat 进程**：跑 LLM loop，**不能**看到 master credentials。和 web 之间走 HTTPS + HS256 JWT，输入视为不可信。
- **运行时防线现状**（FORBIDDEN_ENVS 单一真源：`pinai-agents/src/pinai_agents/chat/trust_boundary.py`）：
  - **本地 compose 仍生效**：Makefile `ensure-env-pinai-agents` 派生 `.env.chat`，本地 chat 容器看不到 master credentials。
  - **fly 部署上暂时降级**：flyctl 没有 per-process-group secret（验过 0.4.48），fly 上 chat 进程实际能看到 master credentials。`chat/asgi.py` 的 boot fail-fast 已注释掉、`scripts/sync_fly_secrets.py` 退化成 app-level 整体推（详见 script docstring 和 `chat/asgi.py` 文件头）。下一次 web/chat 拆成两个独立 fly app 时再启用运行时防线。
- **静态防线（仍生效）**：ruff `flake8-tidy-imports.banned-api` 禁止 `pinai_agents.web` ↔ `pinai_agents.chat` 互相 import；CI 跑 `scripts/check_trust_boundary.sh` 兜底 grep 检查方向性；共享类型放 `pinai_agents.shared/`（纯 model / protocol）。改动 trust boundary 前必读 `chat/trust_boundary.py` 的 docstring。

## 环境拓扑

| 环境 | pinai-agents (web+chat) | Frontend | Internal reward dashboard | LiteLLM |
|------|--------------------------|----------|---------------------------|---------|
| dev | `proactive-ai-agents-dev` | `proactive-ai-frontend-dev` | `proactive-ai-reward-dashboard-dev` | `proactive-ai-litellm-dev` |
| test | `proactive-ai-agents-test` | `proactive-ai-frontend-test` | 暂无独立 app | `proactive-ai-litellm-test` |
| prod | `proactive-ai-agents-prod` | `proactive-ai-frontend-prod` | 暂无独立 app | `proactive-ai-litellm-prod` |

所有 fly app 都在 `iad` / `ord` region。Daytona sandbox 是 chat 进程的远端执行环境（python_exec、browser tool 跑在那里），不算 fly app。

## Secrets 管理（dotenvx）
所有环境变量（后端 secrets + 前端 VITE_*）用 [dotenvx](https://dotenvx.com/) 加密 checkin，每环境一把私钥。

```
pinai-agents/.env.dev / .env.test / .env.production       # 后端 + VITE_* 加密真源（已 checkin）
ops/litellm/.env.dev / .env.test / .env.production        # LiteLLM 加密真源
pinai-agents/.env.keys / ops/litellm/.env.keys            # 私钥，不 checkin，找团队成员获取
pinai-agents/.env / pinai-agents/.env.chat / ops/litellm/.env  # 本地明文，make ensure-env 自动生成，不要手改、不要 commit
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
- `proactive-ai-frontend/src/`：React SPA（Vite + Tailwind + Capacitor，支持 Web/iOS/Android）。
- `internal-reward-dashboard/src/`：内部 reward review app（`/runs`、`/cards/:cardId`、`/casebook`、`/traces/:runId`、`/personal-data`），本地端口 `3004`，不要混进主产品前端。
- `ops/litellm/`：LiteLLM 配置 + fly toml + 部署脚本。

## 文档读取规则（AI 必读）
`docs/` 是团队开发和 AI agent 查询的统一上下文。读取顺序必须渐进式展开：

1. 先读 [`docs/index.mdx`](docs/index.mdx)，确认该任务属于哪个模块。
2. 再读相关的 `docs/modules/*.mdx`。模块文档是当前事实，改代码前以它为准。
3. 只有当模块文档底部出现 `相关 AI Plans`，或任务明确涉及对应设计取舍时，才继续读 `docs/plans/*.mdx`。
4. 不要把 `docs/plans/` 当历史归档。plan 只是可引用的 AI 设计计划，不替代模块文档。
5. 如果代码行为和文档冲突，以代码核实当前事实，并同步更新对应模块文档。

> ⚠️ 部分 `docs/modules/*.mdx`（尤其 `runtime-deployment.mdx`）还残留 `apis/` / `pinai-openclaw/` 时代的描述，碰到时以 `pinai-agents/` 实际代码为准，并顺手更新该模块文档。后端搬迁的设计 SSOT 在 [`docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx`](docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx)。

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
# 找团队成员获取 .env.keys
# 放到 pinai-agents/.env.keys 和 ops/litellm/.env.keys
make up                    # 自动解密 .env.dev → .env，构建并启动所有服务
```

全栈启动（Docker Compose）：
```bash
make up                    # 启动 postgres + litellm + pinai-web + pinai-chat + frontend
make logs                  # 跟所有 log
make logs-pinai-web        # 单看 web
make logs-pinai-chat       # 单看 chat
make restart               # 改了 pinai-agents 代码后重建 web+chat
make restart-frontend      # 改了前端代码（容器版本）
make reset                 # 清空数据从头来（数据会丢失）
make status                # 查看容器状态
```

轻量开发（不走 Docker）：
```bash
cd pinai-agents && uv sync                          # 装 Python 依赖
cd pinai-agents && uv run uvicorn pinai_agents.web.asgi:app --reload --port 8000
cd pinai-agents && uv run uvicorn pinai_agents.chat.asgi:app --reload --port 8001
cd proactive-ai-frontend && npm run dev             # 前端 dev server（端口 3003）
cd internal-reward-dashboard && npm run dev -- --host 127.0.0.1 --port 3004  # 内部 review app
```

`internal-reward-dashboard` 本地通过 Vite same-origin `/api/*` proxy 打 `pinai-web:8000`，默认从 `pinai-agents/.env` 读取 Supabase `VITE_*`。它当前不是 root npm workspace；dev 环境是独立 Fly app `proactive-ai-reward-dashboard-dev`，不是 `proactive-ai-frontend` 部署产物。

Daytona sandbox 需要公网回连 `pinai-web` 才能完整跑通 generator / chat 的 `python_exec`。本地用 ngrok 暴露：
```bash
cp .env.example .env       # 填 NGROK_AUTHTOKEN / NGROK_DOMAIN / PAI_API_URL
make tunnel-up             # 起 ngrok，re-create pinai-chat 把 PAI_API_URL 注入
make tunnel-status
make tunnel-down
```

Mobile（Capacitor，iOS / Android）：
```bash
make ngrok                 # 单独把 pinai-web 暴露到公网（mobile dev 用，不用于 Daytona）
make ios                   # 构建前端 → cap sync → 打开 Xcode
make android               # 构建前端 → cap sync → 装到 USB device
```
后端切换：`NGROK=<url> make ios` 走临时公网；`DEV=1 make ios` 指 fly dev；`PROD=1 make ios` 指 fly prod；不传变量时使用项目根目录 `./.env` 的 `PAI_API_URL`（ngrok），没配就直接失败，不退回本机 LAN IP。

iOS 真机安装硬规则：永远不要为了绕过签名、权限、验证或并存安装去新增/改用 bundle id、包名、scheme、target，或安装 `*.dev` 之类的新 App。必须直接 build 当前已安装 App 的原 bundle id，并用新包覆盖替换旧 App；如果原 bundle id 的 signing/profile 不满足能力要求，就停下来报告真实 blocker，不要换 bundle id 绕过。

验证：
```bash
cd pinai-agents && uv run ruff check               # 静态检查（含 trust-boundary 防墙）
cd pinai-agents && uv run pytest                   # 后端测试
cd proactive-ai-frontend && npm run type-check     # 前端类型检查
cd proactive-ai-frontend && npm test               # 前端单测（vitest）
cd internal-reward-dashboard && npm run type-check  # 内部 review app 类型检查
cd internal-reward-dashboard && npm test            # 内部 review app 单测
```

改完怎么验证（按改动范围选最轻的）：
- 纯 Python 逻辑/类型 → `uv run ruff check` + 相关 `uv run pytest tests/<path>`
- 改 `pinai-agents/src/pinai_agents/web/` → `make restart`，看 `make logs-pinai-web` 起得来 + 打目标接口
- 改 `pinai-agents/src/pinai_agents/chat/` → `make restart`，看 `make logs-pinai-chat` + 用前端发一条消息验证
- 改前端 → `npm run dev`（端口 3003）在浏览器点；或 `make restart-frontend` 看容器版本
- 改 `internal-reward-dashboard/` → `npm run type-check` + `npm test` + `npm run dev -- --host 127.0.0.1 --port 3004`，在 `/runs` / `/traces/:runId` 点真实流程
- 改 `/api/reward-dashboard/*` 或 reward schema → `uv run ruff check .` + `uv run pytest tests/web/db/repositories/test_reward_repo.py tests/web/routes/test_reward_dashboard.py tests/web/services/test_trace_artifacts.py`
- 改 db migration → `make migrate`，确认 schema 应用成功
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

### Dev 环境
push 到 `proactive-ai-v3` 后按改动范围自动部署（CI workflow：`.github/workflows/deploy-dev.yml`）：
- 改 `pinai-agents/` 或 `proactive-ai-frontend/` → 部署 pinai-agents + 前端
- 改 `ops/litellm/` → 部署 LiteLLM
- Daytona snapshot 跟随 pinai-agents 部署刷新

`internal-reward-dashboard/` 使用独立 workflow `.github/workflows/internal-reward-dashboard-dev.yml`：PR 只跑 type-check / test / build；push 到 `proactive-ai-v3` 且该目录变化时，部署到 Fly dev app `proactive-ai-reward-dashboard-dev`（默认地址 `https://proactive-ai-reward-dashboard-dev.fly.dev`）。

### Test 环境
GitHub Actions 页面手动触发 **Deploy Test**（`deploy-test.yml`）。可以从任意分支部署，用来在合并前在 fly 上跑一次完整链路。

### Prod 环境
在 GitHub Actions 页面手动触发 **Deploy Prod**，或 push `v*` tag。需要 production environment approval。

### 本地部署（备用）
CI/CD 不可用时走 Makefile：
```bash
make deploy-pinai-dev       # pinai-agents (web + chat) → dev
make deploy-pinai-prod      # pinai-agents → prod
make deploy-frontend-dev    # 前端 → dev
make deploy-frontend-prod   # 前端 → prod
make deploy-reward-dashboard-dev  # 内部 reward dashboard → dev
make deploy-litellm-dev     # LiteLLM → dev
make deploy-litellm-prod    # LiteLLM → prod
```
所有 deploy 命令已内置 `env -u all_proxy -u http_proxy -u https_proxy`，避开本机全局代理导致的 flyctl 失败。命令细节看 `Makefile` 对应 target。

## 生产环境硬性规则
- 生产部署优先走 GitHub Actions（有审计日志和 approval）。
- 生产环境禁止直接执行任何数据库变更，migration 必须随部署自动跑。
- 所有生产变更必须走代码评审 + CI/CD。
- Fly secrets 通过 `pinai-agents/scripts/sync_fly_secrets.py` 同步，**不要**手动 `flyctl secrets set` 单 key，否则会绕过 trust boundary。

## 安全约束（P0）
- **Trust boundary**：master credentials（`SUPABASE_SECRET_KEY` / `PAI_JWT_SIGNING_KEY` / `COMPOSIO_API_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `LITELLM_MASTER_KEY`）禁止进入 chat 进程环境。单一真源在 `pinai-agents/src/pinai_agents/chat/trust_boundary.py` 的 `FORBIDDEN_ENVS`；改动 chat secret 注入相关代码后必须确认 `chat/asgi.py` 的 boot fail-fast、Makefile `.env.chat` 派生、`pinai-agents/scripts/sync_fly_secrets.py` 三道防线都还在。
- **Composio 写命令受控**：read/query 类 Composio tool 默认可执行；有副作用的 tool 只有代码 allowlist 内的 `GMAIL_CREATE_EMAIL_DRAFT` / `GMAIL_SEND_DRAFT` 可执行，且必须显式传 side-effect 同意标记。不要指导 agent 用 `GMAIL_SEND_EMAIL` 或 allowlist 外任意 create/update/delete/send tool。
- **JWT 签名隔离**：web 用 EdDSA 私钥签 PAI JWT；chat 用 HS256 共享 secret 验。私钥永远只在 web 进程。
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
3. **`make restart` 只重建 pinai-web/pinai-chat**：动了 frontend 用 `make restart-frontend`，动了 LiteLLM 配置要 `make up` 全栈。
4. **本机全局代理会导致 `flyctl` 失败**：Makefile 已在 deploy 命令内置 `env -u`，但如果直接跑 `flyctl deploy` 要自己 unset。
5. **`.env.chat` 不会自动跟 `.env` 同步**：手动改 `.env` 后，`make ensure-env-pinai-agents` 才会重新派生 `.env.chat`；直接 docker compose up 不会触发，必要时 `make env-local` 强制重新解密。
6. **`apis/` / `pinai-openclaw/` / `miniapp/` 是退役时代的路径**：如果旧脚本、旧文档或本地残留目录提到它们，不要复活旧服务；当前后端事实以 `pinai-agents/` 为准，用户产品前端类型检查走 `cd proactive-ai-frontend && npm run type-check`。
7. **`internal-reward-dashboard/` 是独立内部工具**：不要把 dashboard 页面放进 `proactive-ai-frontend/src/`，不要把 `/api/reward-dashboard/*` 当普通用户产品 API 扩散。用户 confirm / dismiss / snooze / text feedback 仍写 `pai_feedback_events`，只有 card open / score / reviewer score / casebook / trace 走 reward dashboard 链路。

## 提交规范
- Conventional Commits：`feat(...)` / `fix(...)` / `chore(...)` / `docs(...)`。
- 每次提交聚焦一个变更点。
- 提交前最少跑：`cd pinai-agents && uv run ruff check` + 前端动到的话 `cd proactive-ai-frontend && npm run type-check`。

## 规则单一真源
- `AGENTS.md` 是 SSOT。
- `CLAUDE.md`、`GEMINI.md`、`.cursor/rules/agents.mdc` 均指向本文件。
- 未经允许不要乱加 fallback。
- 请使用平实、直接、克制的技术白话中文。禁止大厂黑话（赋能、闭环、底座、抓手等）。多用精确工程术语，从具体事实说起。
