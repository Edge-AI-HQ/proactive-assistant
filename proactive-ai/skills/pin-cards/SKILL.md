---
name: pin-cards
version: 1.0.0
description: "已生成 Intent Card 历史：查询最近生成过的卡片主题，帮助 Planner/Generator 感知近期生成上下文，而不是盲目重复。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "cards recent --help"
---

# cards

## Shared contract

- 默认使用 `--json`（或 `--format json`）读取结构化结果
- 出错先看 `error.hint`
- 写操作优先先跑 `--dry-run`
- 不确定参数时先用 `pin sys schema --json` 或 `pin sys schema <domain.command> --json`

## 核心场景

### 1. 查看最近生成的 Intent Cards

```bash
pin cards recent --json
pin cards recent --limit 10 --json
```

### 2. 按 basket 查看近期生成历史

```bash
pin cards recent --basket work --limit 10 --json
pin cards recent --basket health --since 14d --json
```

### 3. 在生成前做近期主题感知

```bash
# Planner / Generator 在生成前先看最近 10 张
pin cards recent --limit 10 --json
```

读取结果时重点关注：
- `goalBasket`：近期主要覆盖了哪些 life baskets
- `title` / `titleKey`：近期是否已经生成过非常接近的主题
- `generatedAt`：这些卡片是不是刚刚生成，是否仍然算“近期上下文”

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin cards recent [--limit <n>] [--basket <b>] [--since <d>] --json` | 查看最近生成的 Intent Cards | read |

## 返回字段

`pin cards recent` 返回的每条记录至少包含：

| 字段 | 说明 |
|------|------|
| `runId` | 该卡片所属 pipeline run |
| `cardId` | 原始 Intent Card ID |
| `goalBasket` | life basket |
| `title` | 生成时的卡片标题 |
| `titleKey` | 归一化后的标题 key，便于识别相近主题 |
| `whyNow` | 当时生成该卡片的触发原因 |
| `summary` | 卡片摘要 |
| `primaryActionLabel` | 主按钮文案 |
| `sources` | 当时引用的数据来源 |
| `generatedAt` | 该卡片被记录到历史中的时间 |
| `metadata` | 附加上下文，如 agentChain、分数等 |

## 设计原则

- 这是**已生成历史**，不是“已推送历史”
- 这是**上下文感知工具**，不是硬去重器
- 是否仍然值得再次生成，由 Agent 结合 `feedback`、`push` 和当前上下文自己判断
- 首版重点是帮助 Agent 看到“最近产生过什么类型/标题的卡片”

## 与其他 domains 的边界

- `pin cards recent`：看**最近生成过什么**
- `pin push history`：看**最近推送过什么**
- `pin feedback list/stats`：看**用户对什么反馈好/差**

生成前的推荐读取顺序：

1. `pin cards recent --limit 10 --json`
2. `pin push history --since 14d --json`
3. `pin feedback list --since 14d --json`

## Agent 使用建议

- Planner 在决定新一轮 intents 前，先看最近 10 张卡片，避免连续几轮都围绕几乎相同的主题展开
- Generator 在落具体卡片前，再看一次最近历史，避免标题和主行动高度重复
- 如果近期确实应该重复某一主题，应确保这次的 `whyNow`、证据或行动方案明显不同
