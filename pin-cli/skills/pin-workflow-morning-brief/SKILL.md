---
name: pin-workflow-morning-brief
version: 0.2.0
description: "工作流：早间简报生成。编排多个 pin 命令获取日程、邮件、新闻、目标，由 Agent 汇总生成简报。"
metadata:
  requires:
    bins: ["pin"]
  dependencies: ["pin-shared", "pin-ctx", "pin-world", "pin-profile", "pin-push"]
---

# morning-brief

**先读取 [`../pin-shared/SKILL.md`](../pin-shared/SKILL.md)**

> **状态：骨架阶段** — 依赖的 ctx 和 world domain 尚未实现。

## 适用场景

每天早晨为用户生成一份个性化简报，包含当日日程、重要邮件、相关新闻和目标提醒。

## 前置条件

- Gmail 和 Calendar provider 已配置（`pin ctx apps status`）
- RSS feeds 已配置（`pin world rss feeds`）

## 工作流

```
{date} ─┬─► pin ctx calendar events list --from {today} --to {today} ──► 日程列表
        ├─► pin ctx gmail search --query "important OR urgent" --since 1d ──► 重要邮件
        ├─► pin world rss fetch --feed all --limit 20 ──► 新闻
        ├─► pin profile get --id default ──► 用户画像和目标
        └─► pin push history --limit 10 ──► 最近推送（去重参考）
                    │
                    ▼
              Agent 汇总 ──► 早间简报卡片 ──► pin push record
```

## 步骤详解

### Step 1: 获取日程

```bash
pin ctx calendar events list --from $(date +%Y-%m-%d) --to $(date +%Y-%m-%d) --json
```

### Step 2: 获取重要邮件

```bash
pin ctx gmail search --query "important OR urgent OR action required" --since 1d --limit 10 --json
```

### Step 3: 获取新闻

```bash
pin world rss fetch --feed all --limit 20 --json
```

### Step 4: 获取用户画像

```bash
pin profile get --id default --json
```

### Step 5: 去重检查

```bash
pin push history --limit 10 --json
```

### Step 6: Agent 汇总并推送

Agent 综合以上数据生成简报，然后记录推送：

```bash
pin push record --kind digest --title "Morning Brief 2026-04-02" --json
```
