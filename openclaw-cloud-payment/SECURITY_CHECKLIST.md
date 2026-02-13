# 生产环境安全检查清单

## ✅ 已修复的问题

### 1. 删除了无认证的公开接口
- ❌ `api/generate-payment-token.ts` - 已删除
- ❌ `api/generate-token.ts` - 已删除（旧的 JWT 实现）
- ❌ `api/test-supabase.ts` - 已删除（泄露敏感信息）

## 🟢 已有的安全措施

### 1. Token 安全
- ✅ 一次性使用（支付成功后标记为 used）
- ✅ 1 小时过期
- ✅ 加密随机生成（32 字节）
- ✅ 绑定到特定用户

### 2. Stripe Webhook 验证
- ✅ 签名验证（`stripe.webhooks.constructEvent`）
- ✅ 使用 `STRIPE_WEBHOOK_SECRET`

### 3. 数据库安全
- ✅ Row Level Security (RLS) 已启用
- ✅ 使用 Service Role Key 绕过 RLS
- ✅ 防止重复事件处理（`stripe_event_id` unique）

### 4. 支付安全
- ✅ 客户 ID 验证（防止账户切换问题）
- ✅ Token 只在支付成功后标记为已使用
- ✅ 所有敏感操作通过 Stripe 处理

## 🟡 潜在风险（已知但可接受）

### 1. Telegram Webhook 无签名验证
- **风险**：任何人都可以向 webhook 端点发送 POST 请求
- **影响**：可能触发 token 生成，但攻击者需要知道真实的 Telegram user ID
- **缓解措施**：
  - Token 是一次性的，1小时过期
  - 攻击者即使生成 token，也只能帮别人付钱（不是安全威胁）
  - Telegram bot 本身有速率限制
- **评估**：低风险，可接受

## 🟡 建议添加的功能（可选但推荐）

### 1. 速率限制
使用 Vercel Edge Config 或 Upstash Redis：

```typescript
// 示例：限制每个 IP 每分钟最多 10 次请求
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '1 m'),
});

const { success } = await ratelimit.limit(req.headers['x-forwarded-for']);
if (!success) {
  return res.status(429).json({ error: 'Too many requests' });
}
```

### 2. 错误监控
使用 Sentry 或类似服务：

```bash
npm install @sentry/node
```

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});
```

### 3. 环境变量验证
在应用启动时验证所有必需的环境变量：

```typescript
// lib/config.ts
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
];

requiredEnvVars.forEach(key => {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
});
```

### 4. 日志脱敏
确保日志中不包含敏感信息：

```typescript
// ❌ 不要这样
console.log('Customer:', customer);

// ✅ 应该这样
console.log('Customer ID:', customer.id);
```

## 📋 上生产前的最终检查

### 必须完成
- [ ] 切换到 Stripe Live mode
- [ ] 更新所有 Stripe 环境变量为生产密钥
- [ ] 在 Stripe Dashboard 配置生产 webhook
- [ ] 设置 Telegram webhook
- [ ] 完整测试支付流程（使用真实卡号小额测试）
- [ ] 验证 webhook 事件正确处理
- [ ] 检查 Supabase 数据库连接和权限

### 强烈建议
- [ ] 添加错误监控（Sentry）
- [ ] 设置告警（支付失败、webhook 失败）
- [ ] 配置日志聚合
- [ ] 添加 uptime 监控
- [ ] 准备回滚计划
- [ ] 文档化事故响应流程

### 可选优化
- [ ] 添加速率限制
- [ ] 实现幂等性密钥
- [ ] 添加重试机制（Telegram 通知失败）
- [ ] 优化数据库查询性能
- [ ] 添加缓存层

## 🎯 当前安全评级

**评级：🟢 可以上生产**

**前提条件**：
1. 完成上述"必须完成"清单中的所有项目
2. 在测试环境充分测试

**风险等级**：低-中

主要的安全漏洞已修复。Telegram webhook 无验证是已知风险，但影响有限。

## 📞 紧急联系

如果生产环境出现问题：

1. **支付问题**：检查 Stripe Dashboard → Events
2. **Webhook 失败**：`vercel logs --follow`
3. **数据库问题**：Supabase Dashboard → Logs
4. **快速回滚**：`vercel rollback`

## 🔄 定期维护

- 每月检查 Stripe webhook 日志
- 每周检查错误日志
- 定期更新依赖包（`npm audit`）
- 监控数据库大小和性能
