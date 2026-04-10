---
name: pin-personal
version: 0.2.0
description: "个人数据访问：通过 Composio Platform API 连接并读取用户的第三方应用数据（Gmail、Slack、Calendar 等）。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "personal --help"
---

# personal

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

## 前置条件

1. 用户在 [Composio workspace settings](https://app.composio.dev/settings) 中获取 API key（`ak_...`）
2. 设置 `COMPOSIO_API_KEY` 环境变量，或写入 `~/.openclaw-proactive-ai/local-settings.json`

## 核心场景

### 1. 配置 Composio

```bash
pin personal setup --key ak_YOUR_KEY_HERE --json
pin personal status --json
```

### 2. 查看已连接应用

```bash
# 自动发现所有已连接应用
pin personal connections list --json

# 检查特定应用
pin personal connections list --toolkits gmail,slack,googlecalendar --json
```

### 3. 发现可用工具

```bash
# 按用例搜索
pin personal tools search --query "fetch emails" --json
pin personal tools search --query "calendar events" --toolkit googlecalendar --json

# 查看工具参数
pin personal tools schema --name GMAIL_FETCH_EMAILS --json
```

### 4. 执行工具获取数据

```bash
# 获取最近重要邮件
pin personal exec --tool GMAIL_FETCH_EMAILS \
  --input '{"query":"is:important","max_results":5}' --json

# 获取日历事件
pin personal exec --tool GOOGLECALENDAR_EVENTS_LIST \
  --input '{"timeMin":"2026-04-01T00:00:00Z","maxResults":10}' --json

# 获取 Slack 消息
pin personal exec --tool SLACK_FETCH_CONVERSATION_HISTORY \
  --input '{"channel":"general","limit":10}' --json

# 获取 Gmail 用户信息
pin personal exec --tool GMAIL_GET_PROFILE --json

# 多账户：指定具体 connected account（从 connections list 获取 connectedAccountId）
pin personal exec --tool GMAIL_GET_PROFILE --account-id ca_xxx --json
```

### 5. 连接新应用（OAuth）

```bash
# 发起 OAuth，获取授权 URL
pin personal connect --toolkit notion --json
# → 返回 redirectUrl，用户访问后完成授权

# 等待授权完成
pin personal wait --toolkit notion --json
```

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin personal setup --key <ak_...>` | 验证 API key | write |
| `pin personal status` | 检查 key 配置状态 | read |
| `pin personal connections list [--toolkits <list>]` | 列出已连接应用 | read |
| `pin personal connect --toolkit <name>` | 发起 OAuth 连接 | write |
| `pin personal wait --toolkit <name>` | 等待 OAuth 完成 | read |
| `pin personal tools search --query <q> [--toolkit <name>]` | 搜索可用工具 | read |
| `pin personal tools schema --name <TOOL_SLUG>` | 获取工具参数 | read |
| `pin personal exec --tool <TOOL_SLUG> [--input '<json>']` | 执行工具 | write |

## Composio Platform API 映射

| pin-cli 命令 | Composio REST API |
|---|---|
| `connections list` | `GET /connected_accounts?statuses=ACTIVE` |
| `connect` | `POST /connected_accounts/link` |
| `wait` | polling `GET /connected_accounts` until ACTIVE |
| `tools search` | `GET /tools?query=...` |
| `tools schema` | `GET /tools/{slug}` |
| `exec` | `POST /tools/execute/{slug}` |

## Agent 使用模式

```
1. personal connections list     → 看用户连了什么
2. personal tools search         → 找到需要的工具
3. personal tools schema         → 了解参数格式
4. personal exec                 → 获取实际数据
```

先 search 再 schema 再 exec —— 不要猜测 tool slug 或参数名。用 search 确认 slug，用 schema 确认参数名。

## 安全规则

- API key 通过环境变量或本地配置文件传递，不硬编码
- REST API 调用直接从用户机器到 Composio，产品方无法访问用户数据
- 所有工具执行结果不含原始 OAuth token
