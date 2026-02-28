# Assistant 创建限制说明

## 限制规则

**每个用户只能创建一个 assistant bot。**

## 为什么要限制？

### 1. 订阅和计费逻辑简化

- **一个用户 = 一个订阅**
  - Stripe 订阅直接关联到用户，无需区分是哪个 bot
  - 扣款回调（usage-based billing）直接应用到用户的唯一 assistant
  - 避免"用户有多个 bot，但只订阅了一个"的复杂情况

### 2. 取消订阅流程简化

- **无需选择**：用户取消订阅时，系统明确知道要停止哪个容器
- **避免混淆**：不需要在 UI 中让用户选择取消哪个 bot 的订阅
- **代码简单**：取消订阅的逻辑不需要处理多个 assistant 的情况

### 3. 用户体验更清晰

- **一对一关系**：用户 ↔ Assistant ↔ 订阅 ↔ 容器
- **避免困惑**：用户不会疑惑"我订阅了，为什么有的 bot 能用有的不能用"
- **更好的沟通**：Telegram 消息可以直接说"你的 assistant"而不是"你的哪个 assistant"

### 4. 数据库设计简化

当前 `user_subscriptions` 表结构：

```sql
CREATE TABLE user_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,  -- 一个用户一条记录
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  ...
);
```

这个设计假设**一个用户只有一个订阅**。如果允许多个 assistant：

- 需要改为 `assistant_subscriptions` 表
- 需要在所有订阅相关代码中传递 `assistant_id`
- 需要重构整个计费系统

## 实现细节

### 检查位置

`apis/src/domain/claw-assistant/service.ts` 的 `ensureAssistantRecord` 函数：

```typescript
// 限制：一个用户只能创建一个 assistant
const existingAssistants = await listAssistantsByOwnerTelegramId(ownerTelegramUserId);
if (existingAssistants.length > 0) {
  throw new Error("USER_ALREADY_HAS_ASSISTANT");
}
```

### 错误处理

1. **Service 层**：抛出 `USER_ALREADY_HAS_ASSISTANT` 错误
2. **Usecases 层**：转换为 HTTP 409 Conflict
3. **Telegram bot**：显示友好的中文错误消息

### 用户消息

```
⚠️ 你已经有一个 assistant bot 了。

目前，每个用户限制只能创建一个 assistant bot。
如果你想创建新的，请先使用 /my_assistants 命令删除现有的 assistant。

💡 提示：你可以通过在 /create_assistant 命令中使用相同的 token 来更新现有 bot 的 token。
```

## 如何创建新的 Assistant

如果用户想要更换 assistant：

1. **方式一：更新现有的**（推荐）
   - 在 @BotFather 中编辑现有 bot 或创建新 bot
   - 使用新 bot 的 token 运行 `/create_assistant` 命令
   - 系统会更新现有 assistant 记录到新 bot
   - 订阅和容器无缝迁移

2. **方式二：删除后重建**
   - 运行 `/my_assistants` 命令
   - 选择删除现有的 assistant
   - 等待容器销毁完成
   - 使用新 token 运行 `/create_assistant` 命令
   - ⚠️ **注意**：订阅会保留，但容器需要重新创建

## 未来扩展

如果以后需要支持多个 assistant：

### 需要修改的地方

1. **数据库**：
   - 创建 `assistant_subscriptions` 表
   - 迁移现有的 `user_subscriptions` 数据
   - 添加 `assistant_id` 外键

2. **订阅逻辑**：
   - Stripe checkout 需要传递 `assistant_id`
   - Webhook 处理需要区分是哪个 assistant
   - 取消订阅需要传递 `assistant_id`

3. **计费逻辑**：
   - LiteLLM usage callback 需要区分 assistant
   - Budget tracking 需要按 assistant 分组
   - 扣款需要关联到正确的订阅

4. **用户界面**：
   - `/my_assistants` 需要显示每个 bot 的订阅状态
   - 需要添加"选择 assistant"的交互流程
   - 取消订阅需要选择器

5. **估算工作量**：约 2-3 周的开发 + 测试时间

## 相关代码

- `apis/src/domain/claw-assistant/service.ts` - Assistant 创建逻辑
- `apis/src/domain/claw-assistant/usecases.ts` - 错误处理
- `apis/src/domain/telegram-bot/commands.ts` - Telegram 命令处理
- `apis/src/domain/payment/paymentStoreSubscription.ts` - 订阅管理

## 测试场景

### ✅ 正常场景

1. 新用户创建第一个 assistant → 成功
2. 用户更新现有 assistant 的 token → 成功
3. 用户删除 assistant 后创建新的 → 成功

### ❌ 错误场景

1. 用户尝试创建第二个 assistant → 显示错误消息
2. 用户未删除旧的就尝试添加新的 → 提示需要删除旧的
