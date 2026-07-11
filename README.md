# PIN AI Assistant Monorepo

PIN AI Assistant 的产品主线是 Proactive AI：后端是 `backend/` 下的 uv workspace monorepo，拆成 api（受信任主进程）、agent-engine（无信任 agent 执行引擎）、reward-dashboard（内部 review 后端）三个 service；前端是「一套共享层（`packages/*`）+ 多个端壳（`apps/*`）」，登录走 Supabase Auth，模型调用统一走 LiteLLM。

规则、硬约束和 AI coding 规范的单一真源是 [`AGENTS.md`](AGENTS.md)，本 README 只做入口。

## 开发文档

团队开发和 AI agent 查询以 `docs/modules/` 为准：

- [Data Connectors](docs/modules/data-connectors.mdx)：Composio、device、mobile 数据接入。
- [Memory](docs/modules/memory.mdx)：lifelong-memory 三层 + 投影管线 + evolve。
- [Generation](docs/modules/generation.mdx)：卡片生成 pipeline。
- [Execution](docs/modules/execution.mdx)：chat-stream、agent 工具面、browser tool、control mode。
- [Feedback](docs/modules/feedback.mdx)：反馈事件和学习回流。
- [Background Tasks](docs/modules/background-tasks.mdx)：任务队列、scheduler、reconciler。
- [Internal Reward Dashboard](docs/modules/internal-reward-dashboard.mdx)：内部卡片 review 工具。
- [Runtime & Deployment](docs/modules/runtime-deployment.mdx)：本地启动、部署、安全、billing 概览。

Mintlify 入口：[`docs/index.mdx`](docs/index.mdx)。

## 高频目录

```text
backend/                      # Python uv workspace：api / agent-engine / reward-dashboard 三 service + libs/{contracts,db}
packages/                     # 跨端前端共享层（web/RN 双端）：core / design / state / ui-kit
apps/web/                     # zebra 桌面 web 端（Vite + React，已上线 dev/prod；功能层 src/ui-web）
apps/desktop/                 # Electron macOS 壳，renderer 复用 apps/web（仅本地）
apps/mobile/                  # Expo React Native iOS app（TestFlight 分发）
internal-reward-dashboard/    # 内部卡片 review 工具前端（独立 Vite app）
ops/litellm/                  # LiteLLM 配置和部署
docs/                         # 团队开发文档
docs/plans/                   # 可引用 AI 设计计划，不做历史归档
```

## 本地开发

首次设置：

```bash
cd backend && uv sync && cd -
npm install                                      # root workspace：packages/* + apps/*
cd internal-reward-dashboard && npm install && cd -
# 找团队成员获取 dotenvx 私钥，放进 ~/.zshrc：export DOTENV_PRIVATE_KEY_DEV=...
make up
```

常用命令：

```bash
make up
make logs
make restart
make status
make urls        # 本 worktree 的随机 host 端口 + ngrok URL
make help
```

轻量开发（不走 Docker）：

```bash
cd backend && uv run uvicorn pinai_api.asgi:app --reload --port 8000        # api 进程
cd backend && uv run uvicorn agent_engine.asgi:app --reload --port 8001     # agent-engine 进程
cd apps/web && npm run dev                                                  # zebra web（端口 3005）
```

验证：

```bash
cd backend && uv run ruff check && uv run lint-imports && uv run mypy services libs && uv run pytest
npm run check:packages
cd apps/web && npm run type-check && npm test
```

完整命令和按改动范围的验证矩阵见 [`AGENTS.md`](AGENTS.md)「本地开发」节。

## 维护规则

- 规则、硬约束和 AI coding 规范见 [`AGENTS.md`](AGENTS.md)。
- 当前模块事实见 `docs/modules/*.mdx`。
- 可引用 AI 设计计划见 `docs/plans/*.mdx`，只有被模块文档引用时才保留。
- 改核心链路时，同步更新对应模块文档。
