---
name: pin-profile
version: 1.0.0
description: "用户画像核心：profile 基础字段 + facts / preferences / goals / constraints。memory 写入 / 检索请用 pin-memory（v3）。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "profile --help"
---

# profile

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

> v3 提示：原本属于 profile 的 memory / signal / interests / snapshot 在
> v3 已经独立成 [`pin memory`](../pin-memory/SKILL.md)（如有）/ `pin signals`
> 等命令。本文件只覆盖 profile 自己的字段操作；事实层（facts / observations
> / preferences）请优先用 `pin memory list/add/search`。

## 核心场景

### 1. 获取画像（紧凑 / 完整输出）

```bash
pin profile get --id default --json
pin profile get --id default --full --json   # 含 facts / preferences / constraints / metadata
pin profile list --json
```

### 2. 创建或更新基础画像

```bash
pin profile create --id default --display-name "Alice" --locale en-US --timezone Asia/Shanghai --json
pin profile update --id default --summary "Founder focused on AI infra" --metadata '{"source":"cli"}' --json
```

### 3. 维护稳定 facts / preferences / goals / constraints (v2 sink, 仍 work)

```bash
pin profile facts set --key home_city --value-json '"Shanghai"' --json
pin profile facts get --key home_city --json
pin profile preferences set --key topics --value-json '["ai","startups"]' --json
pin profile goals upsert --key fundraising --title "Close seed round" --priority high --json
pin profile constraints set --key quiet_hours --value-json '"23:00-08:00"' --json
```

> 这些 v2 字段 v3 没动，旧调用点都还能用。新事实推荐写到 v3 memory：
> `pin memory add "<text>" --subject self --quality 0.7`。

## v3 替代关系

| v2 命令（仍可用） | v3 推荐 | 何时切换 |
|---|---|---|
| `pin profile memory list` | `pin memory list --quality 0.5+ --limit 30` | 新代码 |
| `pin profile memory add` | `pin memory add "<text>" --quality 0.6 --subject self` | 新代码 |
| `pin profile memory search` | `pin memory search --query <q> --limit 10` | 新代码 |
| `pin profile interests list` | `pin memory list --subjectPrefix topic: --quality 0.6+` | 新代码 |
| `pin profile signal add/rollup` | 无直接替代；用 `pin signals ingest`（personal_signals） | 新代码 |
| `pin profile snapshot build` | 直接组合 `pin memory list` + `pin profile get` | 新代码 |

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin profile create --id <id> --display-name <name> --json` | 创建画像 | write |
| `pin profile get --id <id> [--full] --json` | 获取画像 | read |
| `pin profile list [--full] --json` | 列出所有画像 | read |
| `pin profile update --id <id> --json` | 更新画像（summary / metadata / locale / timezone） | write |
| `pin profile delete --id <id> --json` | 删除画像 | write |
| `pin profile facts get/set/unset --json` | 管理稳定 facts | read/write |
| `pin profile preferences get/set/unset --json` | 管理 preferences | read/write |
| `pin profile goals list/upsert/close --json` | 管理 goals | read/write |
| `pin profile constraints get/set/unset --json` | 管理 constraints | read/write |

## 安全规则

- `facts` 与 `constraints` 是相对稳定信息，覆盖前先确认不是瞬时状态。
- 写新事实 / 观察前优先考虑 `pin memory add`，让进化 agent 后续合并。
- 删除 / 覆盖前确认目标 profile 与 key。
