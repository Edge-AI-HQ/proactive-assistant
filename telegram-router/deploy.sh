#!/bin/bash

# 快速部署脚本

set -e

echo "🚀 部署 Telegram Router 到 Fly.io"
echo "================================"
echo ""

# 1. 检查 flyctl
if ! command -v flyctl &> /dev/null; then
    echo "❌ flyctl 未安装"
    echo "请运行: brew install flyctl"
    exit 1
fi

echo "✅ flyctl 已安装"
echo ""

# 2. 登录 Fly
echo "🔐 检查 Fly 登录状态..."
if ! flyctl auth whoami &> /dev/null; then
    echo "请先登录 Fly.io:"
    flyctl auth login
fi

echo "✅ 已登录 Fly.io"
echo ""

# 3. 创建 app (如果不存在)
echo "📦 检查 Fly app..."
FLY_APP="${FLY_APP:-pinclaw-telegram-router-dev}"

if ! flyctl apps list | grep -q "$FLY_APP"; then
    echo "创建新 app: $FLY_APP"
    flyctl apps create "$FLY_APP" --org personal
else
    echo "✅ App 已存在"
fi

echo ""

# 4. 设置环境变量
echo "🔧 设置环境变量..."
flyctl secrets set \
  TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}" \
  TELEGRAM_WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}" \
  DATABASE_URL="${DATABASE_URL:?set DATABASE_URL}" \
  -a "$FLY_APP"

echo "✅ 环境变量已设置"
echo ""

# 5. 部署
echo "🚀 部署到 Fly.io..."
flyctl deploy -a "$FLY_APP"

echo ""
echo "================================"
echo "✅ 部署完成！"
echo ""

# 6. 获取 URL
ROUTER_URL="${FLY_APP}.fly.dev"
echo "📡 Router URL: https://${ROUTER_URL}"
echo ""

# 7. 配置 Telegram Webhook
echo "🔧 配置 Telegram Webhook..."
WEBHOOK_RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"https://${ROUTER_URL}/webhook/telegram\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"
  }")

if echo "$WEBHOOK_RESPONSE" | grep -q '"ok":true'; then
    echo "✅ Webhook 配置成功"
else
    echo "❌ Webhook 配置失败: $WEBHOOK_RESPONSE"
fi

echo ""
echo "================================"
echo "🎉 全部完成！"
echo ""
echo "📊 查看日志: flyctl logs -a $FLY_APP"
echo "🔍 查看状态: flyctl status -a $FLY_APP"
echo ""
