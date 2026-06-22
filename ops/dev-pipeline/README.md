# dev-pipeline

内部研发流水线的 **Linear-side agent**：在 Linear 里以 app 身份接需求 → 读代码出 plan →
等人确认 → 委派 Codex 实现 → 按需起 Fly preview 看效果。全程人在 Linear 里主动驱动，
没有后台轮询 / 自动收敛循环。

独立内部工具，不碰产品线（不 import `pinai-agents` / 前端）。设计 SSOT：
[`docs/plans/2026-06-13-ai-dev-pipeline.mdx`](../../docs/plans/2026-06-13-ai-dev-pipeline.mdx)。

## 结构

```
src/dev_pipeline/
  config.py            # pydantic-settings，密钥走 gitignored .env
  app.py               # FastAPI: /healthz + OAuth 安装 + /webhook/linear
  service.py           # 编排：plan → 等确认 → 委派 Codex → 按需 preview
  planner.py           # agent 的"脑子"：grep/read 代码 → 出 plan（Claude）
  linear/              # webhook 验签/解析 + GraphQL client + actor=app OAuth
  github/              # gh CLI 封装（查 PR + CI rollup + 触发 preview workflow）
  store.py             # SQLite kv：app token / plan 草稿 / awaiting 标记
tests/                 # 全 mock，无 live 调用
scripts/               # wire_linear.py（配 Linear 回调/webhook）+ expose.sh（起服务+tunnel）
```

preview 本身是仓库根 `.github/workflows/preview.yml`（起 `pinai-pr-<N>.fly.dev`）+
`preview-cleanup.yml`（PR 关闭时销毁）；service 只负责 CI 绿后 `gh workflow run` 按一下。

## 开发

```bash
cd ops/dev-pipeline
uv sync
uv run ruff check . && uv run mypy && uv run pytest -q
```

## 链路（核心）

- 需求级对话主场 = Linear AgentSession（同 thread 续 session）。
- 代码级对话主场 = GitHub PR（评论 → Codex 推新 commit）。
- 确认闸门：created 出 plan 后停下等人回「ok」，**不**直接 @Codex；确认才 delegate。
- 触发 Codex 的唯一可靠方式 = `issueUpdate(delegateId=<codex>)`（assigneeId / 纯文本
  @mention 都不行）。
- 护栏：Codex 只在 `dev-pipeline/*` 分支开 PR，**绝不 auto-merge**；人去 GitHub merge。
