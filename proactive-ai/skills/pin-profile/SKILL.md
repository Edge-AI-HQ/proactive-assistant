---
name: pin-profile
version: 0.3.0
description: "用户画像管理：创建/读取/更新 profile、goals、constraints、preferences、memory。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "profile --help"
---

# profile

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

## 核心场景

### 1. 获取用户画像快照

```bash
pin profile get --id default --json
```

### 2. 创建初始画像

```bash
pin profile create --id default --display-name "Alice" --locale en-US --timezone Asia/Shanghai --json
```

### 3. 管理目标

```bash
pin profile goals list --json
pin profile goals upsert --key career-growth --title "Advance career" --priority high --json
pin profile goals close --key old-goal --json
```

### 4. 管理记忆

```bash
pin profile memory add --content "用户偏好早上收到重要邮件摘要" --json
pin profile memory search --query "邮件偏好" --json
pin profile memory list --json
```

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin profile create --id <id> --display-name <name>` | 创建画像 | write |
| `pin profile get --id <id>` | 获取画像 | read |
| `pin profile list` | 列出所有画像 | read |
| `pin profile update --id <id>` | 更新画像 | write |
| `pin profile delete --id <id>` | 删除画像 | write |
| `pin profile facts get` | 获取事实 | read |
| `pin profile facts set --key <k> --value-json '<json>'` | 设置事实 | write |
| `pin profile facts unset --key <k>` | 删除事实 | write |
| `pin profile preferences get` | 获取偏好 | read |
| `pin profile preferences set --key <k> --value-json '<json>'` | 设置偏好 | write |
| `pin profile preferences unset --key <k>` | 删除偏好 | write |
| `pin profile goals list` | 列出目标 | read |
| `pin profile goals upsert --key <k> --title <t> --priority high\|medium\|low` | 创建/更新目标 | write |
| `pin profile goals close --key <k>` | 关闭目标 | write |
| `pin profile constraints get` | 获取约束 | read |
| `pin profile constraints set --key <k> --value-json '<json>'` | 设置约束 | write |
| `pin profile constraints unset --key <k>` | 删除约束 | write |
| `pin profile memory list` | 列出记忆 | read |
| `pin profile memory add --content <text>` | 添加记忆 | write |
| `pin profile memory search --query <q>` | 搜索记忆 | read |
| `pin profile memory remove --id <id>` | 删除记忆 | write |

## 安全规则

- 写入/删除操作前确认用户意图
- 用 `--dry-run` 预览危险请求
