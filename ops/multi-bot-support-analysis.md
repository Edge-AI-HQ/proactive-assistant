# 多 Bot 支持分析

## 当前系统架构

### 数据模型

```
users (用户表)
├── id (主键)
├── telegram_user_id (Telegram 用户 ID，唯一)
├── litellm_user_id (LiteLLM 用户 ID)
├── litellm_virtual_key (共享的 LiteLLM 密钥)
└── litellm_spend_usd / litellm_budget_usd (消费和预算)

assistants (助手表)
├── id (主键)
├── owner_user_id (关联到 users.id)
├── assistant_bot_id (Bot ID，唯一)
├── assistant_bot_token (Bot Token，唯一)
└── 没有独立的 LiteLLM 密钥字段

user_subscriptions (订阅表)
├── telegram_user_id (关联到用户)
├── stripe_customer_id
├── stripe_subscription_id
└── plan_id
```

## 问题分析

### ✅ 已支持的功能

1. **多 Bot 创建**：
   - ✅ 一个用户可以创建多个 assistant bot
   - ✅ 每个 bot 有独立的容器和配置
   - ✅ 数据库 schema 支持一对多关系

2. **Bot 隔离**：
   - ✅ 每个 bot 有独立的 `assistant_bot_id`
   - ✅ 每个 bot 有独立的容器
   - ✅ 可以列出某个用户的所有 bot

### ❌ 当前存在的问题

#### 1. **LiteLLM 预算和消费是用户级别的，不是 Bot 级别的**

**代码证据**：

```typescript
// apis/src/domain/litellm/service.ts:119
const litellmUserId = owner.litellm_user_id?.trim() || 
                      assistant.litellm_user_id?.trim() || 
                      buildLiteLLMUserId(owner.id);

// apis/src/domain/litellm/service.ts:146-154
// 所有同一用户的 assistant 共享同一个 LiteLLM virtual key
let shared = toSharedKeyStateFromUser(owner) ?? 
             toSharedKeyStateFromAssistant(assistant);

if (!shared) {
  const siblings = await listAssistantsByOwnerTelegramId(ownerTelegramUserId);
  const siblingWithKey = siblings.find((item) => 
    item.id !== assistant.id && item.litellm_virtual_key?.trim()
  );
  if (siblingWithKey) {
    shared = toSharedKeyStateFromAssistant(siblingWithKey);
  }
}
```

**影响**：
- ✅ 用户的所有 bot **共享同一个 LiteLLM 用户 ID**
- ✅ 用户的所有 bot **共享同一个 budget 和 spend**
- ❌ 无法区分哪个 bot 消费了多少
- ❌ 任何一个 bot 超出预算，所有 bot 都会被限制

#### 2. **Stripe 订阅是用户级别的，不是 Bot 级别的**

**代码证据**：

```typescript
// apis/src/domain/payment/subscriptionSync.ts:71-73
const telegram_user_id = session.metadata?.telegram_user_id?.trim();
// 没有 assistant_id 或 bot_id 字段

// apis/src/domain/payment/subscriptionSync.ts:98
await db.upsertUserSubscription(payload);
// user_subscriptions 表只有 telegram_user_id，没有 assistant_id
```

**影响**：
- ✅ 一个用户只能有一个 Stripe 订阅
- ❌ 无法为不同的 bot 订阅不同的套餐
- ❌ 取消订阅会影响所有 bot
- ❌ 无法单独取消某个 bot 的订阅

#### 3. **Invoice 回调无法区分具体哪个 Bot**

**代码证据**：

```typescript
// apis/src/domain/payment/subscriptionSync.ts:446-484
export async function handleInvoicePaid(
  eventId: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  // 只通过 telegram_user_id 查找订阅
  const subscription = await resolveSubscriptionFromInvoice(invoice);
  
  if (!subscription?.telegram_user_id) {
    console.warn("invoice.paid could not resolve subscription user");
    return;
  }
  
  // 重置的是整个用户的 spend，不是单个 bot 的
  await syncLiteLLMBudgetFromPlan({
    telegram_user_id: subscription.telegram_user_id,
    plan_code: planCode,
    source: "stripe_invoice_paid",
    reset_spend: true,  // 重置整个用户的消费
  });
}
```

**影响**：
- ✅ Invoice 回调能找到正确的用户
- ❌ Invoice 回调不知道是哪个 bot 触发的订阅
- ✅ 但因为是用户级别的订阅，这个行为是"正确"的

## 当前系统的设计意图

根据代码分析，当前系统的设计是：

```
一个用户 (telegram_user_id)
├── 可以创建多个 assistant bot
├── 但只有一个 LiteLLM 用户账号
├── 只有一个 Stripe 订阅
├── 所有 bot 共享同一个 budget
└── 所有 bot 共享同一个 spend limit
```

这是一个 **"用户付费模式"**，而不是 **"按 Bot 付费模式"**。

## 需要的改进

### 方案 A：保持当前设计（推荐）

如果继续使用"用户付费"模式，需要：

1. ✅ **文档说明**：
   - 在 Telegram bot 中明确告知用户
   - "您的所有 bot 共享同一个订阅和额度"
   - "取消订阅将影响您的所有 bot"

2. ✅ **UI 改进**：
   - 显示用户当前有几个 bot
   - 显示总消费（所有 bot 累计）
   - 取消订阅时警告"将影响您的 X 个 bot"

3. ✅ **限制创建数量**（可选）：
   ```typescript
   // 限制免费用户只能创建 1 个 bot
   // Pro 用户可以创建 3 个 bot
   // Max 用户可以创建 10 个 bot
   ```

### 方案 B：改为按 Bot 付费（需要大量重构）

如果要支持每个 Bot 独立订阅，需要：

1. **数据库改动**：
   ```sql
   -- 方案 1: 订阅关联到 assistant
   ALTER TABLE user_subscriptions 
     ADD COLUMN assistant_id BIGINT REFERENCES assistants(id);
   
   -- 方案 2: 每个 assistant 有独立的 LiteLLM user
   ALTER TABLE assistants 
     ADD COLUMN litellm_user_id TEXT,
     ADD COLUMN litellm_virtual_key TEXT,
     ADD COLUMN litellm_spend_usd NUMERIC(18,6),
     ADD COLUMN litellm_budget_usd NUMERIC(18,6);
   ```

2. **LiteLLM 集成改动**：
   - 为每个 assistant 创建独立的 LiteLLM user
   - 独立跟踪每个 bot 的消费
   - 独立设置每个 bot 的 budget

3. **Stripe checkout 改动**：
   ```typescript
   // 创建 checkout session 时传入 assistant_id
   metadata: {
     telegram_user_id: String(userId),
     assistant_id: String(assistantId),  // 新增
     plan: planCode
   }
   ```

4. **Webhook 处理改动**：
   ```typescript
   // 根据 assistant_id 更新对应 bot 的订阅
   const assistantId = session.metadata?.assistant_id;
   await db.upsertAssistantSubscription({
     assistant_id: assistantId,
     stripe_subscription_id: session.subscription
   });
   ```

5. **取消订阅改动**：
   - 需要让用户选择取消哪个 bot 的订阅
   - 或者提供"取消全部"选项

## 推荐方案

### 短期（现在）：方案 A - 保持用户付费模式

**优点**：
- ✅ 无需代码改动
- ✅ 更简单的用户体验
- ✅ 更容易管理和计费
- ✅ 避免用户为每个 bot 单独付费的麻烦

**缺点**：
- ❌ 用户可能觉得不公平（一个 bot 用完额度影响其他 bot）
- ❌ 无法为不同 bot 设置不同套餐

**实现步骤**：

1. **添加文档和提示**：
   ```typescript
   // Telegram bot 消息
   "⚠️ 注意：您的所有助手共享同一个订阅额度。"
   "当前您有 {count} 个助手，本月已消费 ${spend}。"
   ```

2. **添加创建限制**（可选）：
   ```typescript
   async function canCreateMoreAssistants(userId: number): Promise<boolean> {
     const assistants = await listAssistantsByOwnerTelegramId(userId);
     const subscription = await getSubscriptionByTelegramId(String(userId));
     
     const limits = {
       free: 1,
       basic: 1,
       pro: 3,
       max: 10
     };
     
     const planCode = subscription?.plan_id || 'free';
     return assistants.length < limits[planCode];
   }
   ```

3. **改进取消订阅提示**：
   ```typescript
   "⚠️ 取消订阅将影响您的所有 {count} 个助手。\n" +
   "确定要继续吗？"
   ```

### 长期（未来）：方案 B - 按 Bot 付费（如果用户需求强烈）

只有在用户强烈要求时才考虑，因为：
- 需要大量重构
- 增加系统复杂度
- 可能降低用户转化率（每个 bot 都要付费）

## 当前优先级

1. **高优先级**：添加多 bot 说明和提示
2. **中优先级**：添加创建数量限制
3. **低优先级**：改为按 Bot 付费（需要用户调研）

## 建议

当前系统对于 MVP 阶段是合理的。建议：

1. ✅ **保持现状**（用户付费模式）
2. ✅ **添加清晰的说明**
3. ✅ **限制免费用户创建数量**（避免滥用）
4. ⏳ **观察用户反馈**，如果很多用户要求按 Bot 付费，再考虑重构
