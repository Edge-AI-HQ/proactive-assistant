---
name: pin-feedback
version: 0.2.0
description: "反馈系统：记录和查询用户显式/隐式反馈事件，支持 Agent 迭代优化。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "pin feedback --help"
---

# feedback

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

> **状态：骨架阶段** — 所有命令当前返回 NOT_IMPLEMENTED。

## 核心场景

### 1. 记录用户反馈

```bash
pin feedback log --kind explicit_rating --item-id push_555 --value thumbs_up --json
pin feedback log --kind card_click --item-id card_123 --value open_article --json
```

### 2. 查询近期反馈

```bash
pin feedback list --since 7d --json
```

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin feedback log --kind <k> --json` | 记录反馈事件 | write |
| `pin feedback list --since <d> --json` | 列出反馈事件 | read |
| `pin feedback get --id <id> --json` | 获取单条反馈 | read |

## 反馈类型

| kind | 说明 |
|------|------|
| `card_open` | 用户打开了推送卡片 |
| `card_click` | 用户点击了卡片内操作 |
| `explicit_rating` | 用户显式评分（thumbs_up/down） |
| `dismiss` | 用户关闭了推送 |
