---
name: pin-push
version: 0.2.0
description: "推送记录：追踪推送了什么、何时推送、投递结果，支持去重和效果评估。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "pin push --help"
---

# push

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

> **状态：骨架阶段** — 所有命令当前返回 NOT_IMPLEMENTED。

## 核心场景

### 1. 记录推送

```bash
pin push record --kind proactive_card --title "AI funding roundup" --ref article_set_77 --json
```

### 2. 去重检查

```bash
pin push find-similar --kind proactive_card --ref article_set_77 --since 14d --json
```

### 3. 记录投递结果

```bash
pin push outcome --id push_123 --status clicked --json
```

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin push record --kind <k> --title <t> --json` | 记录推送 | write |
| `pin push history --limit <n> --json` | 推送历史 | read |
| `pin push get --id <id> --json` | 获取单条推送 | read |
| `pin push outcome --id <id> --status <s> --json` | 记录投递结果 | write |
| `pin push find-similar --kind <k> --json` | 查找相似推送 | read |

## 设计原则

- CLI 只负责存储和读取事实
- 是否过于重复，由 Agent 决定
