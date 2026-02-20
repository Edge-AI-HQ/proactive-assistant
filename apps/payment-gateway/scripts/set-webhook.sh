#!/bin/bash

echo "🔗 设置 Telegram Webhook"
echo ""

# 加载环境变量
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ 未找到 .env 文件"
    exit 1
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ TELEGRAM_BOT_TOKEN 未配置"
    exit 1
fi

if [ -z "$TELEGRAM_WEBHOOK_DOMAIN" ]; then
    echo "❌ TELEGRAM_WEBHOOK_DOMAIN 未配置"
    echo "   请先部署到 Vercel，然后在 .env 中设置域名"
    exit 1
fi

webhook_url="$TELEGRAM_WEBHOOK_DOMAIN/api/webhook/telegram"

echo "📡 设置 Webhook URL: $webhook_url"
echo ""

response=$(curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$webhook_url\"}")

if echo "$response" | grep -q '"ok":true'; then
    echo "✅ Webhook 设置成功！"
    echo ""
    echo "验证 Webhook 状态:"
    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" | \
        grep -o '"url":"[^"]*"' | cut -d'"' -f4
else
    echo "❌ Webhook 设置失败"
    echo "$response"
fi
