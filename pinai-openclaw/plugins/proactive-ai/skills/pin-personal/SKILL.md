---
name: pin-personal
version: 0.3.0
description: "个人数据访问：读取用户的第三方应用数据，以及端侧上报的 mobile 高价值 items（attention_item / moment / session_summary）。"
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

### 6. 读取端侧 mobile 高价值 items

这些数据不是 Composio 第三方连接，而是手机端已经预处理后上报到个人后端的第一方上下文。适合卡片生成、卡片 follow-up、以及“用户现在在干嘛”的快速判断。

```bash
# 看最近待处理的 mobile items
pin personal mobile items list --status pending --limit 20 --json

# 按类型过滤
pin personal mobile items list --status pending --type attention_item --limit 10 --json
pin personal mobile items list --status pending --type session_summary --since 24h --limit 10 --json
pin personal mobile items list --status pending --type moment --since 6h --limit 10 --json

# 按设备过滤
pin personal mobile items list --status pending --device-id device-xxx --limit 20 --json
```

结果里重点关注：
- `attention_item`：需要处理的提醒、通知、通信、日历变化
- `session_summary`：语音转录或端侧模型整理过的阶段摘要
- `moment`：高层状态变化，不是原始传感器流

### 7. 消费 mobile items（高级）

只有当你的工作流确实要“消费并标记已处理”时，才使用 `claim/commit`。  
普通上下文读取、卡片生成前的调研，优先用 `list`，不要随手改状态。

```bash
# 领取一批 item
pin personal mobile items claim --limit 10 --json
pin personal mobile items claim --type attention_item --limit 5 --json

# 处理完成后提交
pin personal mobile items commit --run-token run_xxx --json
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
| `pin personal mobile items list [--status <s>] [--type <t>] [--since <d>] [--device-id <id>]` | 查看端侧高价值 items | read |
| `pin personal mobile items claim [--type <t>] [--limit <n>]` | 领取一批端侧 items | write |
| `pin personal mobile items commit --run-token <token>` | 提交已处理 items | write |

## Composio MCP 映射

| pin-cli 命令 | Composio MCP meta tool |
|---|---|
| `connections list` | `COMPOSIO_SEARCH_TOOLS` / `COMPOSIO_MANAGE_CONNECTIONS` |
| `connect` | `COMPOSIO_MANAGE_CONNECTIONS` |
| `wait` | `COMPOSIO_WAIT_FOR_CONNECTIONS` |
| `tools search` | `COMPOSIO_SEARCH_TOOLS` |
| `tools schema` | `COMPOSIO_GET_TOOL_SCHEMAS` |
| `exec` | `COMPOSIO_MULTI_EXECUTE_TOOL` |

## Agent 使用模式

```
1. personal connections list     → 看用户连了什么
2. personal tools search         → 找到需要的工具
3. personal tools schema         → 了解参数格式
4. personal exec                 → 获取实际数据
```

先 search 再 schema 再 exec —— 不要猜测 tool slug 或参数名。用 search 确认 slug，用 schema 确认参数名。

### mobile items 使用模式

```
1. personal mobile items list    → 看最近端侧高价值上下文
2. 仅在需要消费队列时使用 claim
3. 完成处理后再 commit
```

卡片生成、用户当前状态判断、卡片 follow-up，通常从 `list` 开始就够了。

## 安全规则

- API key 通过环境变量或本地配置文件传递，不硬编码
- MCP 调用直接从用户机器到 Composio，产品方无法访问用户数据
- 所有工具执行结果不含原始 OAuth token
- mobile items 是端侧预处理后的高价值结果，不是原始手机全量日志
