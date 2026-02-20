#!/bin/bash

echo "🚀 OpenClaw Cloud - 快速部署脚本"
echo ""

# 检查是否安装了必要的工具
command -v node >/dev/null 2>&1 || { echo "❌ 需要安装 Node.js"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ 需要安装 npm"; exit 1; }

# 安装依赖
echo "📦 安装依赖..."
npm install

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "⚠️  未找到 .env 文件"
    echo "📝 从 .env.example 创建 .env..."
    cp .env.example .env
    echo ""
    echo "⚠️  请编辑 .env 文件，填入你的密钥："
    echo "   - TELEGRAM_BOT_TOKEN"
    echo "   - STRIPE_SECRET_KEY"
    echo "   - STRIPE_WEBHOOK_SECRET"
    echo "   - STRIPE_PRICE_ID_BASIC"
    echo "   - STRIPE_PRICE_ID_PRO"
    echo "   - STRIPE_PRICE_ID_MAX"
    echo "   - SUPABASE_DB_URL"
    echo ""
    echo "填写完成后，重新运行此脚本"
    exit 1
fi

# 检查 Vercel CLI
if ! command -v vercel &> /dev/null; then
    echo "📥 安装 Vercel CLI..."
    npm install -g vercel
fi

# 登录 Vercel
echo ""
echo "🔐 登录 Vercel..."
vercel login

# 部署
echo ""
echo "🚀 开始部署..."
vercel --prod

echo ""
echo "✅ 部署完成！"
echo ""
echo "📋 下一步："
echo "1. 复制部署 URL"
echo "2. 设置 Telegram Webhook:"
echo "   curl -X POST \"https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook\" \\"
echo "     -d \"url=https://your-app.vercel.app/api/webhook/telegram\""
echo ""
echo "3. 设置 Stripe Webhook:"
echo "   Dashboard → Developers → Webhooks → Add endpoint"
echo "   URL: https://your-app.vercel.app/api/webhook/stripe"
echo ""
echo "4. 测试订阅页面:"
echo "   https://your-app.vercel.app/api/subscribe"
