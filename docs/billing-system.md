# Billing System Design

## Overview

PIN AI Assistant 使用 **Stripe** 管理订阅付款，使用 **LiteLLM** 管理 API 调用额度（credits）。
两者通过 Stripe Webhook 事件桥接：只有在 Stripe 确认收款成功后（`invoice.paid`），才会重置用户的 LiteLLM 额度。

## 核心设计原则

1. **付款确认才给额度** — `invoice.paid` 是唯一触发 LiteLLM spend 重置和 max_budget 设置的事件
2. **升级不退款，重置账期** — 取消旧订阅（不退款），创建新订阅，新的 30 天周期
3. **降级下期生效** — 当前周期保持原有额度，Stripe 下次续费按新价格收费
4. **不依赖 LiteLLM 自动重置** — 不设置 `budget_duration`，完全由我们控制 spend 重置时机

## 套餐配置

| 套餐 | 月费 | Credits/月 | LiteLLM max_budget |
|------|------|-----------|-------------------|
| Basic | $10 | 1,000 | $10.00 |
| Pro | $20 | 2,000 | $20.00 |
| Max | $50 | 5,000 | $50.00 |

> 换算关系：100 credits = $1 USD（LiteLLM 使用 USD 作为 budget 单位）

## 订阅生命周期

### 新订阅

```
用户选择套餐 → Stripe Checkout → 付款
    ↓
checkout.session.completed → 保存订阅信息到 DB
    ↓
customer.subscription.created → 更新 DB 状态 + 启动容器
    ↓
invoice.paid → 重置 spend=0 + 设置 max_budget ← 额度生效
```

### 升级（例：Basic → Max）

```
用户选择更高套餐
    ↓
createCheckoutSession 检测到升级
    ↓
立即取消旧订阅（stripe.subscriptions.cancel）← 不退款
    ↓
创建新 Stripe Checkout Session
    ↓
用户支付新套餐全额（$50）
    ↓
checkout.session.completed → DB 更新为新订阅
    ↓
invoice.paid → 重置 spend=0 + max_budget=$50 ← 新额度生效
```

**安全性**：旧订阅取消后，`subscription.deleted` 事件会检查 DB 中是否已有新订阅，
如果有则跳过 budget 清零，避免覆盖新订阅的额度。

### 降级（例：Max → Basic）

```
用户选择更低套餐
    ↓
createCheckoutSession 检测到降级
    ↓
stripe.subscriptions.update({
  proration_behavior: 'none'  ← 不退款
})
    ↓
DB 更新 plan_id，但 LiteLLM max_budget 不变
    ↓
用户继续使用 Max 额度直到周期结束
    ↓
周期结束，Stripe 按 Basic 价格续费
    ↓
invoice.paid → 重置 spend=0 + max_budget=$10 ← 降级生效
```

### 续费

```
Stripe 在周期结束时自动扣款
    ↓
invoice.paid → 重置 spend=0 + 设置 max_budget ← 新周期额度
```

### 取消订阅

```
cancel_at_period_end = true
    ↓
用户继续使用直到周期结束
    ↓
周期结束，subscription.deleted 触发
    ↓
max_budget=0 + 停止容器
```

## Stripe Webhook 事件处理

| 事件 | 处理 |
|------|------|
| `checkout.session.completed` | 保存订阅信息（customer_id, subscription_id, plan_id） |
| `customer.subscription.created` | 更新 DB 状态 + 启动容器（不动 budget） |
| `customer.subscription.updated` | 更新 DB 状态 + 启动/停止容器（不动 budget） |
| `customer.subscription.deleted` | 更新 DB 状态 + budget=0 + 停止容器（仅当前订阅） |
| `invoice.paid` | **重置 spend + 设置 max_budget**（唯一触发点） |

### 为什么不在 subscription 事件中 sync budget？

1. **时序问题**：Stripe 扣款和 Webhook 送达有延迟，可能导致周期还没结束就重置了额度
2. **升级安全**：升级时旧订阅的 `subscription.deleted` 和新订阅的 `invoice.paid` 到达顺序不确定
3. **降级保护**：降级后 `subscription.updated` 如果立即 sync budget，用户当期额度会被降低

## 防薅羊毛（Anti-Exploit）分析

### 升级套利

**攻击**：用完低价套餐额度 → 升级 → 获得高价额度 → 降级获得退款

**防御**：
- 升级 = 取消旧订阅（**不退款**）+ 支付新套餐全价
- 用户只会多花钱，不会少花

| 时间 | 操作 | Stripe 收费 | 累计付出 | Credits 获得 |
|------|------|-----------|---------|-------------|
| Day 1 | 订阅 Basic | $10 | $10 | 1,000 |
| Day 1 | 用完 1000 | - | $10 | - |
| Day 1 | 升级 Max | $50 (不退旧的) | $60 | 5,000 |
| Day 15 | 降级 Basic | 下期生效 | $60 | 保持 5,000 |
| Day 30 | 续费 Basic | $10 | $70 | 1,000 |

用户付了 $60 获得 6,000 credits（$60），公平。

### 用完额度再降级

**攻击**：高价套餐用完所有额度 → 降级获得退款

**防御**：降级不退款，下期生效
- 本期额度不变（已经用完了）
- 下期按低价计费
- Stripe 不产生任何退款

### Webhook 延迟

**场景**：续费扣款成功但 webhook 延迟 1 小时

**结果**：用户额度用完后无法使用，1 小时后 `invoice.paid` 到达，重置额度恢复正常。
这是可接受的（最多几小时延迟），且比提前给额度更安全。

### 扣款失败

**场景**：信用卡余额不足

**结果**：
- Stripe 标记 `past_due`，自动重试（3-4 次，跨越数天）
- 不会收到 `invoice.paid` → 不会重置额度
- 用户额度用完后停止服务
- 扣款成功后收到 `invoice.paid` → 恢复正常

## LiteLLM 集成

### 不使用 budget_duration

LiteLLM 支持 `budget_duration`（如 `"30d"`）自动重置 spend，但我们**不使用**这个功能，原因：

- LiteLLM 的 30 天周期与 Stripe 的计费周期不同步
- 时间一长两个周期会漂移
- 可能在 Stripe 还没收到钱时就重置了额度

### API 调用

| 操作 | LiteLLM API | 时机 |
|------|------------|------|
| 重置 spend | `POST /user/reset` | `invoice.paid` |
| 设置 max_budget | `POST /user/update` | `invoice.paid` |
| 清零 budget | `POST /user/update {max_budget: 0}` | `subscription.deleted` |

## 关键文件

```
apis/src/domain/payment/
├── checkout.ts          # Checkout 流程（升级/降级判断）
├── subscriptionSync.ts  # Webhook 事件处理（DB + 容器 + budget）
├── litellmBudget.ts     # LiteLLM budget 同步（reset_spend + max_budget）
├── webhook.ts           # Stripe Webhook 路由分发
├── pages.ts             # 订阅/成功/取消页面渲染
├── db.ts                # 数据库连接
├── paymentStore.ts      # 数据库操作接口
└── stripeClient.ts      # Stripe 客户端配置

apis/src/domain/litellm/
├── client.ts            # LiteLLM API 客户端（含 resetLiteLLMUserSpend）
└── runtime.ts           # LiteLLM 运行时配置

apis/src/controller/
└── payment_routes.ts    # HTTP 路由注册
```

## 数据库表

### billing_plans

套餐定义，包含 `plan_code`, `stripe_price_id`, `price_cents_monthly`, `monthly_refresh_credits` 等字段。

### user_subscriptions

用户订阅状态，包含 `stripe_subscription_id`, `stripe_customer_id`, `plan_id`, `status`,
`current_period_start`, `current_period_end`, `cancel_at_period_end` 等字段。

通过 `last_stripe_event_created` 和 `last_stripe_event_id` 实现 Webhook 事件幂等处理和乱序保护。

### payment_events

Stripe Webhook 事件记录，用于幂等处理和故障排查。

## 环境变量

| 变量 | 说明 |
|------|------|
| `STRIPE_SECRET_KEY` | Stripe API 密钥 |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 签名密钥 |
| `PAYMENT_PUBLIC_BASE_URL` | 支付页面公开 URL（用于 success/cancel 回调） |
| `LITELLM_BASE_URL` | LiteLLM 服务地址 |
| `LITELLM_MASTER_KEY` | LiteLLM 管理密钥 |
| `SUPABASE_DB_URL` | 数据库连接字符串 |

## 流程图

```
┌──────────┐     ┌─────────┐     ┌──────────┐     ┌─────────┐
│ Telegram │     │ Web UI  │     │  Stripe  │     │ LiteLLM │
│   Bot    │     │(Subscribe)│   │          │     │         │
└────┬─────┘     └────┬─────┘    └────┬─────┘     └────┬────┘
     │                │               │                 │
     │ /start_subscribe               │                 │
     ├───────────────►│               │                 │
     │                │               │                 │
     │                │ POST /create-checkout            │
     │                ├──────────────►│                  │
     │                │               │                  │
     │                │  ┌────────────┤                  │
     │                │  │ 升级？取消旧订阅               │
     │                │  │ 降级？update(no proration)     │
     │                │  └────────────┤                  │
     │                │               │                  │
     │                │◄──────────────┤                  │
     │                │  checkout URL │                  │
     │                │               │                  │
     │                │──────────────►│                  │
     │                │  用户付款      │                  │
     │                │               │                  │
     │                │               │ checkout.completed
     │                │               ├─────► DB update  │
     │                │               │                  │
     │                │               │ subscription.created
     │                │               ├─────► 启动容器    │
     │                │               │                  │
     │                │               │ invoice.paid     │
     │                │               ├─────────────────►│
     │                │               │  reset spend     │
     │                │               │  set max_budget  │
     │                │               │                  │
     │◄──────────────────── Telegram 通知：容器就绪       │
     │                │               │                  │
```
