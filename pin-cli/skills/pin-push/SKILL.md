---
name: pin-push
version: 1.0.0
description: "推送记录：追踪推送了什么、何时推送、投递结果，支持去重和效果评估。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "push --help"
---

# push

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

## 核心场景

### 1. 记录推送（关联 intent card）

```bash
pin push record --kind proactive_card --title "AI funding roundup" \
  --intent-card-id ic_001 --basket work --channel telegram \
  --ref article_set_77 --reason "matches user interest" --json
```

### 2. 查看推送历史

```bash
pin push history --since 7d --basket work --json
pin push history --kind digest --limit 10 --json
```

### 3. 获取单条推送（含投递结果）

```bash
pin push get --id push_abc123 --json
# 返回 { ...record, outcomes: [...] }
```

### 4. 记录投递结果

```bash
pin push outcome --id push_abc123 --status clicked --json
```

### 5. 去重检查

```bash
pin push find-similar --kind proactive_card --ref article_set_77 --since 14d --json
pin push find-similar --kind proactive_card --title "funding" --since 7d --json
```

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin push record --kind <k> --title <t> [--intent-card-id <id>] [--basket <b>] [--channel <c>] [--ref <r>] [--reason <r>] --json` | 记录推送 | write |
| `pin push history [--kind <k>] [--basket <b>] [--channel <c>] [--since <d>] [--limit <n>] --json` | 推送历史 | read |
| `pin push get --id <id> --json` | 获取单条推送（含 outcomes） | read |
| `pin push outcome --id <id> --status <s> --json` | 记录投递结果 | write |
| `pin push find-similar --kind <k> [--ref <r>] [--title <t>] [--since <d>] --json` | 查找相似推送（去重） | read |

## 枚举值

- **kind**: `proactive_card` | `notification` | `digest`
- **basket**: `work` | `health` | `family` | `wealth` | `growth` | `life`
- **channel**: `telegram` | `web` | `mobile` | `im`
- **outcome status**: `clicked` | `dismissed` | `ignored` | `converted`

## 设计原则

- CLI 只负责存储和读取事实
- 是否过于重复，由 Agent 决定
- `intent_card_id` 为逻辑关联，不校验其存在性（intent domain 独立实现）
- `push get` 返回关联的 outcomes 数组，便于查看完整推送生命周期
