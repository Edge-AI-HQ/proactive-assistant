# Proactive AI 插件开发约束

继承项目根 AGENTS.md 所有规则。

## 架构
- Pipeline 三阶段（Planner → Generator → Evaluator），改动需理解完整流程。
- Agent 无状态 LLM 调用，通过 `runAgent()` 执行，必须设 timeout。
- 路由用 RouteHandler 链式匹配，新端点加到 router.ts handler 链。

## LLM
- prompt 包含完整上下文（feedback、card history、前序结果）。
- agent 返回 JSON 用 `parseAgentJson()` 安全解析，不直接 `JSON.parse`。

## 数据
- SQLite（better-sqlite3），WAL 模式。DB 操作集中在 `db.ts`。

## Scheduler
- 定时任务用 `inFlight` 防重入，cooldown 不可绕过。

## 流式
- Pipeline 进度通过 SSE EventSink 回传，write 失败静默捕获不中断。

## 红线
- `pinai-openclaw/external/openclaw/` 只读 submodule，禁止修改。
- 插件通过 OpenClaw API 注册，不直接操作 OpenClaw 内部。
