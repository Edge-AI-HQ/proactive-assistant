# PIN AI Assistant Monorepo

PIN AI Assistant 的产品主线是 Proactive AI：前端通过 Supabase Auth 登录，APIs 负责容器编排与 gateway 代理，每个用户对应一台 OpenClaw assistant machine，机器内运行 proactive-ai plugin，模型调用统一走 LiteLLM。

## 开发文档

团队开发和 AI agent 查询以 `docs/modules/` 为准：

- [Data Connectors](docs/modules/data-connectors.mdx)：Composio、device、mobile 数据接入。
- [Memory](docs/modules/memory.mdx)：raw、signals、memory、profile、skill、evolution。
- [Generation](docs/modules/generation.mdx)：卡片生成 pipeline。
- [Feedback](docs/modules/feedback.mdx)：反馈事件和学习回流。
- [Runtime & Deployment](docs/modules/runtime-deployment.mdx)：本地启动、部署、安全、billing 概览。

Mintlify 入口：[`docs/index.mdx`](docs/index.mdx)。

## 高频目录

```text
apis/                         # Express APIs, auth, proxy, payment, container orchestration
pinai-openclaw/plugins/proactive-ai/
                              # 用户容器内 proactive-ai plugin
pinai-openclaw/image/          # OpenClaw 自定义镜像
proactive-ai-frontend/         # React SPA
ops/litellm/                   # LiteLLM 配置和部署
docs/                          # 团队开发文档
docs/plans/                    # 可引用 AI 设计计划，不做历史归档
```

`pinai-openclaw/external/openclaw/` 是上游 OpenClaw submodule，只读参考，禁止修改。

## 本地开发

首次设置：

```bash
npm install
# 找团队成员获取 .env.keys，放到 apis/.env.keys 和 ops/litellm/.env.keys
make up
```

常用命令：

```bash
make up
make logs
make restart
make reset
make status
make help
```

轻量开发：

```bash
npm run dev
cd proactive-ai-frontend && npm run dev
```

验证：

```bash
npm run type-check
npm run test --workspace @pin-ai/apis
```

## 维护规则

- 规则、硬约束和 AI coding 规范见 [`AGENTS.md`](AGENTS.md)。
- 当前模块事实见 `docs/modules/*.mdx`。
- 可引用 AI 设计计划见 `docs/plans/*.mdx`，只有被模块文档引用时才保留。
- 改核心链路时，同步更新对应模块文档。
