---
name: pin-workflow-intent-gen
version: 0.2.0
description: "工作流：意图生成。编排 profile、ctx、world、feedback、push 数据，由 Agent 生成和评估 intent candidates。"
metadata:
  requires:
    bins: ["pin"]
  dependencies: ["pin-shared", "pin-profile", "pin-ctx", "pin-world", "pin-feedback", "pin-push", "pin-agent"]
---

# intent-gen

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

> **状态：骨架阶段** — 依赖的多个 domain 尚未实现。

## 适用场景

Proactive AI Agent 的核心循环：基于用户画像、应用上下文、世界上下文和反馈历史，生成 intent candidates，评估后推送给用户。

## 前置条件

- Profile 已创建（`pin profile get --id default`）
- 至少一个 ctx provider 已配置
- 至少一个 world source 已配置

## 工作流

```
Step 1: pin profile get ──► 用户画像 + 目标 + 约束
Step 2: pin ctx ... ──► 应用上下文（邮件、日历、通知）
Step 3: pin world ... ──► 世界上下文（新闻、趋势）
Step 4: pin feedback list --since 7d ──► 近期反馈信号
Step 5: pin push history --limit 50 ──► 推送历史（去重）
        │
        ▼
  Agent 生成 intent candidates ──► pin agent artifacts put
        │
        ▼
  Agent 评估 intents ──► pin agent artifacts put
        │
        ▼
  最终推送 ──► pin push record
```

## 步骤详解

### Step 1: 获取用户画像

```bash
pin profile get --id default --json
```

### Step 2: 获取应用上下文

根据用户已配置的 apps 选择性查询：

```bash
pin ctx apps list --json
pin ctx gmail search --query "..." --since 1d --json
pin ctx calendar events list --from ... --to ... --json
```

### Step 3: 获取世界上下文

```bash
pin world rss fetch --feed all --limit 30 --json
pin world articles search --query "..." --since 7d --json
```

### Step 4: 获取反馈信号

```bash
pin feedback list --since 7d --json
```

### Step 5: 去重检查

```bash
pin push history --limit 50 --json
```

### Step 6: 保存产物

```bash
pin agent artifacts put --kind intent_candidate --file ./candidates.json --json
pin agent artifacts put --kind evaluation_result --file ./evaluation.json --json
```

### Step 7: 推送

```bash
pin push record --kind proactive_card --title "..." --ref intent_xxx --json
```
