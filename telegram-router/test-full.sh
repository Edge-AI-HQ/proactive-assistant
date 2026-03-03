#!/bin/bash

# 完整测试脚本：验证 Telegram 消息路由

set -e

echo "🚀 Telegram 消息路由完整测试"
echo "================================"
echo ""

# 加载环境变量
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
    echo "✅ 已加载 .env 文件"
else
    echo "❌ .env 文件不存在"
    exit 1
fi

echo ""

# 1. 检查环境变量
echo "📋 检查环境变量..."
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ TELEGRAM_BOT_TOKEN 未设置"
    exit 1
fi

if [ -z "$TELEGRAM_WEBHOOK_SECRET" ]; then
    echo "❌ TELEGRAM_WEBHOOK_SECRET 未设置"
    exit 1
fi

if [ -z "$SUPABASE_DB_URL" ] && [ -z "$DATABASE_URL" ]; then
    echo "❌ SUPABASE_DB_URL 未设置（兼容旧变量 DATABASE_URL）"
    exit 1
fi

echo "✅ 环境变量检查通过"
echo ""

# 2. 启动路由服务
echo "🚀 启动路由服务..."
pkill -f "bun run index.ts" 2>/dev/null || true
sleep 1
bun run dev > /tmp/router.log 2>&1 &
ROUTER_PID=$!
sleep 2

if ! curl -s http://localhost:3001/health > /dev/null; then
    echo "❌ 路由服务启动失败"
    cat /tmp/router.log
    exit 1
fi

echo "✅ 路由服务已启动 (PID: $ROUTER_PID)"
echo ""

# 3. 启动 ngrok
echo "🌐 启动 ngrok..."
pkill ngrok 2>/dev/null || true
sleep 1
ngrok http 3001 > /dev/null 2>&1 &
NGROK_PID=$!
sleep 3

NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*\.ngrok[^"]*' | head -1)

if [ -z "$NGROK_URL" ]; then
    echo "❌ 无法获取 ngrok URL"
    kill $ROUTER_PID $NGROK_PID 2>/dev/null || true
    exit 1
fi

echo "✅ ngrok 已启动: $NGROK_URL"
echo ""

# 4. 配置 Telegram webhook
echo "🔧 配置 Telegram Bot Webhook..."
WEBHOOK_RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${NGROK_URL}/webhook/telegram\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"
  }")

if echo "$WEBHOOK_RESPONSE" | grep -q '"ok":true'; then
    echo "✅ Webhook 配置成功"
else
    echo "❌ Webhook 配置失败: $WEBHOOK_RESPONSE"
    kill $ROUTER_PID $NGROK_PID 2>/dev/null || true
    exit 1
fi

cleanup() {
    echo ""
    echo "🛑 停止服务..."
    kill $ROUTER_PID $NGROK_PID 2>/dev/null || true
    exit 0
}

trap cleanup INT TERM

echo ""
echo "================================"
echo "✅ 测试环境已就绪！"
echo ""
echo "📱 Bot: @smile_pinai_local_bot"
echo "🌐 Webhook: $NGROK_URL/webhook/telegram"
echo ""
echo "📊 实时日志："
echo "================================"
echo ""

# 5. 实时显示日志
tail -f /tmp/router.log
