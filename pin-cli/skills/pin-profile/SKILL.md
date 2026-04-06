---
name: pin-profile
version: 0.3.0
description: "用户画像管理：管理 profile、facts、preferences、goals、constraints、memory，以及 signal rollup / interests / snapshot。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "profile --help"
---

# profile

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

## 核心场景

### 1. 获取画像（紧凑输出 / 完整输出）

```bash
pin profile get --id default --json
pin profile get --id default --full --json
pin profile list --json
```

### 2. 创建或更新基础画像

```bash
pin profile create --id default --display-name "Alice" --locale en-US --timezone Asia/Shanghai --json
pin profile update --id default --summary "Founder focused on AI infra" --metadata '{"source":"cli"}' --json
```

### 3. 维护稳定 facts / preferences / goals / constraints

```bash
pin profile facts set --key home_city --value-json '"Shanghai"' --json
pin profile preferences set --key topics --value-json '["ai","startups"]' --json
pin profile goals upsert --key fundraising --title "Close seed round" --priority high --json
pin profile constraints set --key quiet_hours --value-json '"23:00-08:00"' --json
```

### 4. 管理 memory

```bash
pin profile memory add --kind observation --text "User often reads AI infra news" --tags-json '["ai","infra"]' --json
pin profile memory search --query "infra" --json
pin profile memory list --json
```

### 5. 写入行为信号并构建画像衍生物

```bash
pin profile signal add --id default --kind liked --target-type topic --target-key ai --source explicit --json
pin profile signal rollup --id default --since 30d --json
pin profile interests list --id default --kind topic --limit 20 --json
pin profile snapshot build --id default --view ranking --json
```

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin profile create --id <id> --display-name <name> [--full] --json` | 创建画像 | write |
| `pin profile get --id <id> [--full] --json` | 获取画像 | read |
| `pin profile list [--full] --json` | 列出所有画像 | read |
| `pin profile update --id <id> --json` | 更新画像 | write |
| `pin profile delete --id <id> --json` | 删除画像 | write |
| `pin profile facts get/set/unset --json` | 管理稳定 facts | read/write |
| `pin profile preferences get/set/unset --json` | 管理 preferences | read/write |
| `pin profile goals list/upsert/close --json` | 管理 goals | read/write |
| `pin profile constraints get/set/unset --json` | 管理 constraints | read/write |
| `pin profile memory list/add/search/remove --json` | 管理 memory | read/write |
| `pin profile signal add/rollup --json` | 写入信号并聚合 | write |
| `pin profile interests list --id <id> --json` | 查看 rollup 后 interests | read |
| `pin profile snapshot build --id <id> [--view <view>] --json` | 构建 ranking snapshot | write |

## 结构说明

- `facts / preferences / goals / constraints / memory` 默认作用在当前默认 profile。
- `signal add / rollup / interests list / snapshot build` 需要显式传 `--id`。
- `get/list` 默认返回紧凑输出，确实需要完整 JSON 时再加 `--full`。

## 安全规则

- `facts` 与 `constraints` 是相对稳定信息，覆盖前先确认不是瞬时状态。
- `signal add` 是原始证据写入；想消费稳定结果时，先执行 `signal rollup`。
- 删除/覆盖前确认目标 profile 与 key。