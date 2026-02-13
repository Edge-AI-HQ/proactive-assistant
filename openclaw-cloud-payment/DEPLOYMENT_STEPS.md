# 生产部署步骤

## 1. 配置 Vercel 环境变量

```bash
# 登录 Vercel
vercel login

# 进入项目目录
cd openclaw-cloud-payment

# 添加生产环境变量
vercel env add TELEGRAM_BOT_TOKEN production
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel env add STRIPE_PRICE_ID_BASIC production
vercel env add STRIPE_PRICE_ID_PRO production
vercel env add STRIPE_PRICE_ID_MAX production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_KEY production
vercel env add TELEGRAM_WEBHOOK_DOMAIN production
```

## 2. 部署到 Vercel

```bash
vercel --prod
```

记录部署后的 URL，例如：`https://your-app.vercel.app`

## 3. 配置 Telegram Webhook

```bash
# 替换以下变量：
# - <YOUR_BOT_TOKEN>: 你的 Telegram bot token
# - <YOUR_VERCEL_URL>: 刚才部署的 Vercel URL

curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://<YOUR_VERCEL_URL>/api/webhook/telegram"
```

**验证 webhook 设置：**
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

应该看到：
```json
{
  "ok": true,
  "result": {
    "url": "https://your-app.vercel.app/api/webhook/telegram",
    "has_custom_certificate": false,
    "pending_update_count": 0
  }
}
```

## 4. 配置 Stripe Webhook

1. 登录 [Stripe Dashboard](https://dashboard.stripe.com/)
2. 切换到 **Live mode**（右上角）
3. 进入 **Developers → Webhooks**
4. 点击 **Add endpoint**
5. 填写：
   - **Endpoint URL**: `https://your-app.vercel.app/api/webhook/stripe`
   - **Events to send**: 选择以下事件
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_succeeded`
     - `invoice.payment_failed`
6. 点击 **Add endpoint**
7. 复制 **Signing secret**（以 `whsec_` 开头）
8. 在 Vercel 更新环境变量：
   ```bash
   vercel env add STRIPE_WEBHOOK_SECRET production
   # 粘贴刚才复制的 signing secret
   ```

## 5. 测试支付流程

### 6.1 测试 Telegram Bot

```bash
# 在 Telegram 中找到你的 bot
# 发送命令：/start
# 应该收到带有 "💳 Subscribe" 按钮的消息
```

### 6.2 测试支付页面

1. 点击 bot 发送的 "💳 Subscribe" 按钮
2. 应该打开支付页面，显示三个套餐
3. 选择一个套餐，点击 "Get Started"
4. 应该跳转到 Stripe Checkout 页面

### 6.3 测试支付（使用测试卡）

**如果还在测试模式：**
- 卡号：`4242 4242 4242 4242`
- 过期日期：任意未来日期
- CVC：任意 3 位数字
- 邮编：任意

**如果已切换到生产模式：**
- 使用真实卡号进行小额测试（建议 $1）

### 6.4 验证 Webhook

1. 支付成功后，检查 Telegram 是否收到通知
2. 检查 Supabase 数据库：
   ```sql
   SELECT * FROM user_subscriptions ORDER BY created_at DESC LIMIT 5;
   SELECT * FROM payment_events ORDER BY created_at DESC LIMIT 5;
   ```
3. 检查 Vercel 日志：
   ```bash
   vercel logs --follow
   ```
4. 检查 Stripe Dashboard → Events

## 6. 监控和告警（可选但推荐）

### 7.1 设置 Uptime 监控

使用 [UptimeRobot](https://uptimerobot.com/) 或 [Pingdom](https://www.pingdom.com/)：
- 监控 URL: `https://your-app.vercel.app/api/health`
- 检查间隔: 5 分钟
- 告警方式: Email/SMS

### 7.2 设置错误监控

```bash
# 安装 Sentry
npm install @sentry/node

# 在 Vercel 添加环境变量
vercel env add SENTRY_DSN production
```

### 7.3 设置 Stripe 告警

在 Stripe Dashboard → Settings → Notifications：
- ✅ Failed payments
- ✅ Disputes
- ✅ Webhook failures

## 7. 回滚计划

如果出现问题，快速回滚：

```bash
# 查看部署历史
vercel ls

# 回滚到上一个版本
vercel rollback
```

## 8. 定期维护

### 每周
- 检查 Vercel 日志是否有错误
- 检查 Stripe webhook 日志

### 每月
- 检查依赖包更新：`npm outdated`
- 运行安全审计：`npm audit`
- 检查 Supabase 数据库大小

### 每季度
- 审查支付数据和订阅状态
- 更新文档
- 性能优化

## 🎉 完成！

你的支付系统现在已经安全地部署到生产环境了。

**重要提醒：**
- 保管好所有的密钥和 secret tokens
- 定期备份 Supabase 数据库
- 监控日志和告警
- 准备好应急响应流程

如有问题，查看 `SECURITY_CHECKLIST.md` 和 Vercel 日志。
