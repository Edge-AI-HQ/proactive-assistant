---
name: pin-feedback
version: 1.0.0
description: "反馈系统：记录和查询用户/Agent 反馈事件，关联 intent_card_id 用于卡片质量评估。"
metadata:
  requires:
    bins: ["pin"]
  cliHelp: "feedback --help"
---

# feedback

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

> v3 提示：feedback 表本身没动；与 v3 卡片评估联动靠 `intent_card_id`
> 与 `card_evaluations` JOIN。计算 hit rate 时分母用 `pin cards recent`
> 数量而不是已废弃的 `pin push history`。

## 核心场景

### 1. 记录用户对 Intent Card 的响应

```bash
pin feedback log --kind card_action --action confirm \
  --intent-card-id ic_001 --basket work --channel telegram \
  --source user_direct --json

pin feedback log --kind explicit_rating --action thumbs_up \
  --intent-card-id ic_001 --source user_direct --json

pin feedback log --kind dismiss --intent-card-id ic_002 \
  --basket health --source user_direct --json
```

### 2. Agent 写入文字反馈

```bash
# 从对话中提炼用户偏好
pin feedback log --kind text_feedback \
  --text "用户表示不想再收到健康类早间提醒" \
  --source user_derived --basket health \
  --conversation-id conv_abc --message-id msg_456 --json

# Agent 自身分析
pin feedback log --kind text_feedback \
  --text "近 3 天 work basket confirm rate 显著下降，建议降低推送频率" \
  --source agent_analysis --basket work --json
```

### 3. 查询近期反馈信号（用于 Intent 生成排序）

```bash
pin feedback list --since 7d --json
pin feedback list --since 7d --kind card_action --action confirm --json
pin feedback list --intent-card-id ic_001 --json
pin feedback list --source agent_analysis --since 3d --json
```

### 4. 计算 v3 卡片质量指标

`feedback_events.intent_card_id` 与 `card_evaluations.card_id` 一致，可以
join 看每张卡的"自评分 vs 用户行为"：

```bash
# 卡片评分 + 反馈拼一下 (agent 端 JOIN)
pin cards recent --limit 100 --json     # 分母 + dim_relevance / overall
pin feedback list --since 14d --json    # 分子（confirm / dismiss）
```

聚合：confirm rate per basket、dismiss rate per basket、self-eval 与
confirm 的相关性 — 详见 `pinai-openclaw/plugins/proactive-ai/evals/online.ts`
里的 `computeOnlineSnapshot` 实现。

## 命令列表

| 命令 | 说明 | 风险 |
|------|------|------|
| `pin feedback log --kind <k> --json` | 记录反馈事件 | write |
| `pin feedback list [--since <d>] --json` | 列出反馈事件 | read |
| `pin feedback get --id <id> --json` | 获取单条反馈 | read |
| `pin feedback stats [--since <d>] --json` | 聚合指标统计（kind/action/basket 分布） | read |

## 反馈类型（kind）

| kind | 说明 |
|------|------|
| `card_open` | 用户打开了 Intent Card |
| `card_action` | 用户执行了卡片内操作 |
| `explicit_rating` | 用户显式评分 |
| `dismiss` | 用户关闭了卡片 |
| `snooze` | 用户选择稍后提醒 |
| `text_feedback` | 文字反馈（Agent 或用户来源） |

## 动作类型（action）

| action | 说明 |
|--------|------|
| `confirm` | 确认执行 |
| `modify` | 修改后执行 |
| `later` | 稍后处理 |
| `thumbs_up` / `thumbs_down` | 显式评分 |
| `open_detail` / `click_cta` | 打开详情 / 点击 CTA |

## 来源类型（source）

| source | 说明 |
|--------|------|
| `user_direct` | 用户直接操作 |
| `user_derived` | Agent 从对话中提炼 |
| `agent_analysis` | Agent 自身分析 |

## 关联字段

| 字段 | 说明 |
|------|------|
| `--intent-card-id` | 关联 Intent Card（与 `card_evaluations.card_id` 对齐） |
| `--conversation-id` | 关联聊天会话 |
| `--message-id` | 关联具体消息 |
| `--push-id` | v2 字段；v3 没有 push 流程，可忽略 |

## 安全规则

- text 字段会经过危险 Unicode 字符过滤
- `--dry-run` 支持 log 命令的写操作预览
- 不在 CLI 内做任何 LLM 调用
