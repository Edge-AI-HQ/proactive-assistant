# Telegram Bot 用户管理功能

## 功能概览

通过 Telegram bot，用户可以管理自己的 assistant 和订阅。

**重要变更：** 已移除删除 assistant 功能，原因见下方说明。

## 为什么不能删除 Assistant？

### Budget 追踪问题

LiteLLM 的 budget 系统通过 `litellm_key` 追踪每个 assistant 的使用量：

```
User → Assistant → LiteLLM Key → Budget → Usage Records
```

如果删除 assistant 并重建：
1. ❌ 旧的 budget 记录会丢失关联
2. ❌ 历史 usage 数据无法追溯到新 assistant
3. ❌ 月度使用量统计会重置
4. ❌ 可能导致重复计费或计费丢失

### 正确的做法

✅ **更新现有 assistant 的 token**
- 保持 budget 和 usage 的连续性
- 历史记录完整保留
- 订阅关系不变
- LiteLLM key 不变

## 命令列表

### 1. `/my_assistants` - 管理我的 Assistant

显示用户的 assistant 详情，提供以下操作：

#### 显示信息
- 🤖 Bot 用户名和链接
- 📊 容器运行状态
- 🔐 LiteLLM API Key 别名

#### 交互按钮

**📊 Manage Subscription**
- 打开订阅管理面板
- 提供 Stripe 管理链接（升级/降级套餐）
- 可以取消订阅

**🔄 Refresh Status**
- 刷新 assistant 状态
- 查看最新的容器状态
- 实时更新信息

### 2. `/cancel_subscription` - 取消订阅

取消当前订阅的快捷命令。

**流程：**
1. 命令触发取消流程
2. 显示当前订阅信息
3. 确认取消
4. 订阅保持活跃直到账期结束
5. 账期结束后容器停止（但不删除配置）

### 3. `/create_claw_assistant` - 创建 Assistant

创建新的 assistant bot。

**限制：**
- 一个用户只能有一个 assistant
- 如需创建新的，需先删除旧的
- 或者可以更新现有 assistant 的 token

### 4. `/gateway` - 打开控制面板

为 assistant 生成临时登录链接，打开 OpenClaw dashboard。

## 如何更换 Assistant 的 Bot？

**推荐方式：更新现有 assistant 的 token**

1. 在 @BotFather 创建新 bot 或编辑现有 bot
2. 获取新 bot 的 token
3. 运行 `/create_claw_assistant`
4. 发送新 token
5. 系统会更新现有 assistant 到新 bot

**优点：**
- ✅ Budget 和 usage 历史完整保留
- ✅ LiteLLM key 保持不变
- ✅ 订阅无缝迁移
- ✅ 不会中断计费追踪

**注意：**
- 旧 bot 的 webhook 会被移除
- 新 bot 会继承所有配置和权限
- 容器会重新创建（约 1-2 分钟）

## 删除 Assistant 流程

**已移除此功能。** 原因：

1. **Budget 追踪丢失**
   - LiteLLM 通过 `litellm_key` 追踪 usage
   - 删除 assistant 会断开 budget 关联
   - 历史数据无法追溯

2. **计费风险**
   - 月度使用量统计会重置
   - 可能导致重复计费或计费丢失
   - 影响订阅管理的准确性

3. **推荐方案**
   - 使用更新 token 的方式切换 bot
   - 保持 budget 和 usage 的连续性

## 订阅管理流程

### 入口 1：通过 /my_assistants

1. 运行 `/my_assistants`
2. 点击 "📊 Manage Subscription"

### 入口 2：直接取消

运行 `/cancel_subscription` 命令

### 订阅管理选项

#### 升级/降级套餐

点击 "💳 Manage Subscription" 按钮：
- 跳转到 Stripe 客户门户
- 可以查看账单历史
- 可以更改套餐
- 可以更新支付方式

#### 取消订阅

点击 "❌ Cancel Subscription" 按钮：

**确认对话框：**
```
⚠️ 确认取消订阅

确定要取消订阅吗？

• 订阅将保持活跃直到当前账期结束
• 之后容器将停止
• 你随时可以重新订阅

注意：这不会删除你的 assistant bot 配置。
```

按钮选项：
- **⚠️ Yes, Cancel Subscription** - 确认取消
- **❌ Keep Subscription** - 保持订阅

**取消成功：**
```
✅ 订阅已成功取消。
你的订阅将保持活跃直到 2026-03-27。
之后容器将停止但不会删除。
你可以随时重新订阅以恢复服务。
```

## 状态刷新

点击 "🔄 Refresh Status" 按钮可以：
- 重新加载 assistant 信息
- 查看最新的容器状态
- 确认配置是否生效

## 常见问题

### Q: 为什么不能删除 assistant？

**A:** 删除 assistant 会导致 budget 追踪丢失：
- LiteLLM 通过 `litellm_key` 追踪每个 assistant 的 usage
- 删除会断开 budget 和 assistant 的关联
- 历史使用量数据无法追溯到新建的 assistant
- 可能导致计费混乱或重复计费

**推荐做法：** 通过更新 token 的方式切换 bot，这样可以保持 budget 和 usage 的连续性。

### Q: 删除 assistant 后订阅会取消吗？

**A:** 此功能已移除，不再支持删除 assistant。

### Q: 取消订阅后 assistant 会删除吗？

**A:** 不会。取消订阅后：
- Assistant 配置保留
- 容器停止运行
- 重新订阅后容器会重新启动
- Bot token 和配置不变

### Q: 如何更换 assistant 的 bot？

**推荐方式：** 更新现有 assistant 的 token
1. 在 @BotFather 创建新 bot
2. 获取新 bot 的 token
3. 运行 `/create_claw_assistant`
4. 发送新 token
5. 系统会更新现有 assistant 到新 bot

**优点：**
- Budget 和 usage 历史完整保留
- LiteLLM key 保持不变
- 订阅无缝迁移

### Q: 可以创建多个 assistant 吗？

**A:** 目前不可以。限制为一个用户一个 assistant，原因：
- 简化订阅和计费逻辑
- 保持 budget 追踪的一致性
- 避免用户混淆
- 一个订阅对应一个 assistant

### Q: 删除 assistant 需要多久？

**A:** 此功能已移除。如需更换 bot，请使用更新 token 的方式。

### Q: 取消订阅后可以重新订阅吗？

**A:** 可以。随时可以：
1. 点击 "📊 Manage Subscription"
2. 选择新的套餐
3. 支付后立即生效
4. 容器自动重新启动

## 技术实现

### API Endpoints

- `GET /api/claw-assistant/owner/:telegram_user_id` - 列出 assistants
- `DELETE /api/claw-assistant/:assistant_id` - 删除 assistant
- `POST /api/payment/cancel-subscription` - 取消订阅
- `POST /api/payment/internal/payment-session` - 创建支付会话

### Callback Query 处理

- `manage_subscription` - 打开订阅管理
- `confirm_cancel_subscription` - 取消订阅确认
- `do_cancel_subscription` - 执行取消
- `keep_subscription` - 保持订阅
- `refresh_assistant_status` - 刷新状态

**已移除：**
- ~~`delete_assistant:{id}`~~ - 删除功能已移除
- ~~`confirm_delete:{id}`~~ - 删除功能已移除
- ~~`cancel_delete`~~ - 删除功能已移除

### 用户体验设计

**二次确认机制：**
- 破坏性操作（取消订阅）需要确认
- 确认对话框清楚说明后果
- 提供取消选项

**即时反馈：**
- 操作进行中显示加载状态
- 成功/失败即时通知
- 错误信息友好易懂

**状态同步：**
- 刷新按钮随时查看最新状态
- 操作完成后自动更新显示
- 避免缓存带来的混淆

## 相关文档

- [Assistant 创建限制](./assistant-limit.md)
- [订阅和计费逻辑](./payment-subscription.md)（如果存在）
