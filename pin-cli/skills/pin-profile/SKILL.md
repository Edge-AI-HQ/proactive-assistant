---
name: pin-profile
version: 0.2.0
description: "用户画像管理：创建/读取/更新 profile、goals、constraints、routines、memory。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "pin profile --help"
---

# profile

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

## 核心场景

### 1. 获取用户画像快照

Agent 需要了解用户全貌时：

```bash
pin profile get --id default --json
```

### 2. 创建初始画像

首次使用时从 Telegram profile 提取基础信息：

```bash
pin profile create --id default --display-name "Alice" --locale en-US --timezone Asia/Shanghai --json
```

### 3. 更新画像

用户偏好变化时：

```bash
pin profile update --id default --display-name "Alice Updated" --metadata '{"interests":["ai","startups"]}' --json
```

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin profile create --id <id> --display-name <name> --json` | 创建画像 | write |
| `pin profile get --id <id> --json` | 获取画像 | read |
| `pin profile list --json` | 列出所有画像 | read |
| `pin profile update --id <id> --json` | 更新画像 | write |
| `pin profile delete --id <id> --json` | 删除画像 | write |

## 即将支持

- `pin profile goals upsert / list / close` — 目标管理
- `pin profile constraints add / list` — 约束条件
- `pin profile routines list` — 日常例程
- `pin profile memory add / search` — 行为记忆

## 安全规则

- 写入/删除操作前确认用户意图
- 用 `--dry-run` 预览危险请求
