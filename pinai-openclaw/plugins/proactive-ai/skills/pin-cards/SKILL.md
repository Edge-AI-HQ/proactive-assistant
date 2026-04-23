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

> v3 提示：`pin cards recent` 是 agent 看"我已经推过哪些卡片"的标准入口；
> 如需结构化评分指标（5 维），用 `pin evolution recent` + `card_evaluations`
> 表的关联（intent_card_id 一致）。"用户当前在做什么"建议用
> `pin signals recent --hours 24`（v3 personal_signals）替代旧的
> `pin personal mobile items list`，两者数据同源但 v3 有 reference 追踪。

## Shared contract

- 默认使用 `--json`（或 `--format json`）读取结构化结果
- 出错先看 `error.hint`
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
pin cards recent --limit 10 --json
pin personal mobile items list --status pending --limit 20 --json
pin personal mobile items list --type contact_directory_snapshot --order desc --limit 1 --json
pin personal mobile items list --type app_inventory_snapshot --order desc --limit 1 --json
```

读取结果时重点关注：
- `goalBasket`：近期主要覆盖了哪些 life baskets
- `title` / `titleKey`：近期是否已经生成过非常接近的主题
- `generatedAt`：这些卡片是不是刚刚生成，是否仍然算“近期上下文”
- 结合 pending mobile items 看用户“现在正在发生什么”，避免只根据历史卡片做静态重复判断
- 当卡片涉及家人/同事/组织关系时，先看最新 `contact_directory_snapshot`
- 当卡片涉及工作栈/安装应用/设备软件时，先看最新 `app_inventory_snapshot`

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin cards recent [--limit <n>] [--basket <b>] [--since <d>] --json` | 查看最近生成的 Intent Cards | read |
