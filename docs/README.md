# 文档导航

团队开发和 AI agent 查询以 `docs/modules/` 为当前事实入口。Mintlify 站点入口是 `index.mdx`。

`docs/plans/` 放可引用的 AI 设计计划，不做历史归档。

## 当前事实文档

- [PIN AI 开发文档](index.mdx)
- [Data Connectors](modules/data-connectors.mdx)
- [Memory](modules/memory.mdx)
- [Generation](modules/generation.mdx)
- [Execution](modules/execution.mdx)
- [Feedback](modules/feedback.mdx)
- [Background Tasks](modules/background-tasks.mdx)
- [Runtime & Deployment](modules/runtime-deployment.mdx)

## 维护规则

- `docs/modules/*.mdx` 是当前依据。
- `docs/plans/*.mdx` 只有被模块文档 `Related AI Plans` 引用时才保留。
- 改模块核心链路时，同步更新对应模块文档。
- `AGENTS.md` 保留 AI coding 规则和硬约束；模块设计不要继续堆进去。

## Related AI Plans

- [Memory Architecture](plans/memory-architecture.mdx)：Memory / Profile / Skill v3 的详细设计补充。新开发优先看 `modules/memory.mdx`，需要追 schema 和迁移细节时再看它。
