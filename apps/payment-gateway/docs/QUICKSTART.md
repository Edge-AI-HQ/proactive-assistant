# 🚀 快速开始指南

## 5 分钟快速测试支付流程

### 前置条件

只需要 3 个东西：
1. ✅ Stripe 测试账号（免费，无需审核）
2. ✅ Supabase 账号（免费）
3. ✅ Vercel 账号（免费）

**不需要 Telegram Bot**（可选）

---

## 第一步：克隆项目

```bash
cd /Users/heyuehui/Desktop/Interesting/Payment
cd openclaw-cloud
npm install
```

---

## 第二步：配置 Supabase（2 分钟）

### 1. 创建项目

访问 https://supabase.com → New Project

- 项目名：`openclaw-cloud`
- 数据库密码：随意设置
- 区域：Singapore

### 2. 执行 SQL

Dashboard → SQL Editor → New Query

复制粘贴 `infra/supabase/migrations/001_unified_schema.sql` 的内容，点击 Run

### 3. 获取数据库连接串

Project Settings → Database → Connection string（URI）

复制：
- `URI` → 用作 `SUPABASE_DB_URL`

---

## 第三步：配置 Stripe（2 分钟）

### 1. 注册

访问 https://dashboard.stripe.com/register

随便填写信息（测试模式不需要真实信息）

### 2. 获取测试密钥

Dashboard 右上角确保是 **Test mode**

Developers → API keys

复制：
- `Publishable key` (pk_test_...)
- `Secret key` (sk_test_...)

### 3. 创建产品（自动化）

稍后用脚本自动创建

---

## 第四步：配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入刚才复制的密钥：

```bash
# Stripe（必填）
STRIPE_SECRET_KEY=sk_test_xxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx  # 稍后填写
STRIPE_PRICE_ID=price_xxxxx  # 稍后填写

# Supabase（必填）
SUPABASE_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require

# Telegram（可选，暂时不填）
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_DOMAIN=

# Docker（可选，暂时不填）
DOCKER_API_URL=
DOCKER_API_KEY=
```

---

## 第五步：创建 Stripe 产品

```bash
chmod +x scripts/create-stripe-product.sh
./scripts/create-stripe-product.sh
```

这会自动创建产品并更新 `.env` 文件中的 `STRIPE_PRICE_ID`

---

## 第六步：部署到 Vercel

```bash
# 安装 Vercel CLI
npm install -g vercel

# 登录
vercel login

# 部署
chmod +x deploy.sh
./deploy.sh
```

按照提示操作，部署完成后会得到一个 URL，例如：
```
https://openclaw-cloud-xxxxx.vercel.app
```

---

## 第七步：配置 Stripe Webhook

### 1. 在 Stripe Dashboard

Developers → Webhooks → Add endpoint

- Endpoint URL: `https://your-app.vercel.app/api/webhook/stripe`
- 选择事件：
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`

### 2. 复制 Signing Secret

点击刚创建的 Webhook → Signing secret → Reveal

复制 `whsec_xxxxx`

### 3. 更新 Vercel 环境变量

```bash
vercel env add STRIPE_WEBHOOK_SECRET
# 粘贴刚才复制的 whsec_xxxxx

# 重新部署
vercel --prod
```

---

## 第八步：测试支付！🎉

### 方法 1：直接访问订阅页面

```
https://your-app.vercel.app/api/subscribe?user_id=test123&username=testuser
```

### 方法 2：在浏览器测试

打开上面的链接，点击"立即订阅"

使用测试卡号：
- 卡号：`4242 4242 4242 4242`
- 过期：`12/34`
- CVC：`123`
- 邮编：`12345`

### 方法 3：在 Telegram 中测试（可选）

如果你想集成 Telegram Bot：

1. 创建 Bot（与 @BotFather 对话）
2. 获取 Token
3. 更新 `.env` 中的 `TELEGRAM_BOT_TOKEN`
4. 运行：
   ```bash
   chmod +x scripts/set-webhook.sh
   ./scripts/set-webhook.sh
   ```

---

## 验证支付成功

### 1. 查看 Stripe Dashboard

Payments → 应该看到 $10.00 的测试支付

### 2. 查看 Supabase

Table Editor → user_subscriptions → 应该看到新记录

### 3. 查看 Vercel 日志

```bash
vercel logs
```

应该看到 Webhook 事件日志

---

## 关于 Apple/Google 支付政策

### ✅ 你的情况是允许的

OpenClaw Cloud 是**云服务**，不是应用内消费的数字内容，所以：

**Apple App Store：**
- ✅ 允许使用 Stripe 等外部支付
- ✅ 可以在 App 内打开 Web 支付页面
- 条件：服务在云端运行，不是 App 内消费

**Google Play Store：**
- ✅ 允许使用外部支付
- ✅ 政策比 Apple 更宽松

### 类似案例

- Netflix：在 App 内引导到网页订阅 ✅
- Spotify：在 App 内引导到网页订阅 ✅
- AWS Console App：使用 AWS 账户付费 ✅

### 实现方式

```typescript
// React Native 示例
import { Linking } from 'react-native';

function subscribe() {
  const userId = getUserId();
  const url = `https://your-app.vercel.app/api/subscribe?user_id=${userId}`;

  // 打开外部浏览器
  Linking.openURL(url);
}
```

---

## 测试脚本

```bash
# 测试所有连接
chmod +x test.sh
./test.sh
```

这会检查：
- ✅ Supabase 连接
- ✅ Stripe 连接
- ✅ Telegram Bot（如果配置了）
- ✅ Webhook 状态
- ✅ Price 配置

---

## 常见问题

### Q: 支付成功但数据库没记录？

检查 Vercel 日志：
```bash
vercel logs --follow
```

查看 Webhook 是否被调用

### Q: Webhook 签名验证失败？

确保：
1. `STRIPE_WEBHOOK_SECRET` 正确
2. Vercel 环境变量已更新
3. 重新部署了应用

### Q: 如何切换到生产环境？

1. Stripe Dashboard 切换到 Live mode
2. 获取生产密钥
3. 更新 Vercel 环境变量
4. 完成 Stripe KYC 认证
5. 绑定银行账户

### Q: Docker 容器怎么办？

暂时可以注释掉 `lib/docker.ts` 中的代码，先测试支付流程。

后续可以集成：
- Railway (https://railway.app)
- Fly.io (https://fly.io)
- 自建 Docker API

---

## 下一步

1. ✅ 完成支付流程测试
2. 🔄 集成 Docker 容器管理
3. 📱 开发 Native App
4. 🎨 优化 UI/UX
5. 📊 添加使用统计
6. 💬 添加客服支持

---

## 项目结构

```
openclaw-cloud/
├── api/                    # Vercel Serverless Functions
│   ├── subscribe.ts        # 订阅页面（独立测试）
│   ├── create-checkout.ts  # 创建支付会话
│   ├── success.ts          # 支付成功页面
│   ├── cancel.ts           # 支付取消页面
│   └── webhook/
│       ├── stripe.ts       # Stripe Webhook
│       └── telegram.ts     # Telegram Webhook（可选）
├── lib/                    # 核心逻辑
│   ├── db.ts               # 数据库操作
│   ├── stripe.ts           # 支付逻辑
│   ├── docker.ts           # 容器管理（可选）
│   └── bot.ts              # Telegram Bot（可选）
├── scripts/                # 辅助脚本
│   ├── create-stripe-product.sh
│   └── set-webhook.sh
├── infra/supabase/
│   └── migrations/
│       └── 001_unified_schema.sql
├── deploy.sh               # 一键部署
├── test.sh                 # 测试脚本
└── README.md
```

---

## 技术支持

- Stripe 文档：https://stripe.com/docs
- Supabase 文档：https://supabase.com/docs
- Vercel 文档：https://vercel.com/docs

---

## 总结

你现在有了一个完整的订阅系统：

✅ 独立的 Web 支付页面（不依赖 Telegram）
✅ 自动订阅扣款
✅ Webhook 事件处理
✅ 数据库记录
✅ 可以集成到任何平台（Web/App/Telegram）

**关键优势：**
- 支付页面独立，可以从任何地方打开
- 符合 Apple/Google 政策
- 测试简单，无需复杂配置
- 生产就绪，只需切换密钥

开始测试吧！🚀
