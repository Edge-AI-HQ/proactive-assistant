---
name: pin-push
version: 2.0.0-deprecated
description: "[DEPRECATED v2 only] 推送记录表，v3 没有 push 流程；查看已推卡片用 pin cards recent，查看反馈用 pin feedback list。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "push --help"
---

# push (DEPRECATED — v2 only)

> ⚠️ **v3 中此 skill 不再被推荐**。`push_records` / `push_outcomes` 表
> 在 v3 schema 中保留但 0 行使用，规划中下个 PR 删除。
>
> v3 的等价路径：
> - 看"agent 已经推过哪些卡片" → `pin cards recent --limit 20`
> - 看"用户对卡片的反馈" → `pin feedback list --since 14d`
> - 看"agent 这次跑做了什么" → `pin evolution recent --limit 5` 加上
>   `pin evolution get --id <run_id>` 看 trajectory
>
> CLI 命令本身仍可调用（不会报错），但写入 push_records 的数据没有任何
> 消费者会读它。**不要在新代码或新 prompt 里推荐这个 skill**。

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

## 历史命令（仅作回滚兼容保留）

```bash
# 记录推送
pin push record --kind proactive_card --title "..." --intent-card-id ic_001 --json

# 查看推送历史
pin push history --since 7d --basket work --json
pin push get --id push_abc123 --json
pin push outcome --id push_abc123 --status clicked --json
pin push find-similar --kind proactive_card --ref article_set_77 --since 14d --json
```

| 命令 | v3 替代 |
|---|---|
| `pin push history --since 7d` | `pin cards recent --limit 50` |
| `pin push get --id <id>` | `pin cards recent` 找到 + `pin feedback list --intent-card-id <card_id>` |
| `pin push outcome --id <id> --status clicked` | `pin feedback log --kind card_action --action confirm --intent-card-id <id>` |
| `pin push find-similar` | `pin cards recent` + agent 自己判断 |

废弃理由：v3 把"已推卡片"事实归入 `pipeline_runs.final_cards`（通过
`pin cards recent` 暴露），把"用户响应"归入 `feedback_events`（通过
`pin feedback list` 暴露），不再需要中间的 push 表。
