---
name: pin-cards
version: 1.1.0
description: "已生成 Intent Card 历史：查询最近生成过的卡片主题，帮助 Planner/Generator 感知近期生成上下文，而不是盲目重复。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "cards recent"
---

# cards

> v3 提示：`pin cards recent` 是 agent 看"我已经推过哪些卡片"的标准入口；
> 如需结构化评分指标（5 维），用 `pin evolution recent` + `card_evaluations`
> 表的关联（intent_card_id 一致）。"用户当前在做什么"建议用
> `pin signals recent --hours 24` 和 `pin raw ...`。

## Shared contract

- 当前 CLI 总是输出 JSON；`--json` / `--format json` 会被入口层剥离
- 出错先看 `error.hint`
- 不确定 domain 时先用 `pin --help` / `pin sys schema`；具体参数以
  `error.hint` 和 `cli/*.ts` 为准

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
pin cards recent --limit 10 --json
pin signals recent --hours 24 --limit 30 --json
pin raw device-contacts list --limit 200 --json
pin raw device-apps --top 20 --json
```

读取结果时重点关注：
- `goalBasket`：近期主要覆盖了哪些 life baskets
- `title` / `titleKey`：近期是否已经生成过非常接近的主题
- `generatedAt`：这些卡片是不是刚刚生成，是否仍然算“近期上下文”
- 结合 `pin signals recent` 看用户“现在正在发生什么”，避免只根据历史卡片做静态重复判断
- 当卡片涉及家人/同事/组织关系时，先看 `pin raw device-contacts ...`
- 当卡片涉及工作栈/安装应用/设备软件时，先看 `pin raw device-apps ...`

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin cards recent [--limit <n>] [--basket <b>] [--since <d>] --json` | 查看最近生成的 Intent Cards | read |
