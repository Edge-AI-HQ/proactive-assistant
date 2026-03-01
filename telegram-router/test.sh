#!/bin/bash

# Telegram Router 快速测试脚本

set -e

echo "🚀 Telegram Router 快速测试"
echo "================================"
echo ""

# 检查依赖
echo "📦 检查依赖..."
if ! command -v bun &> /dev/null; then
    echo "❌ Bun 未安装，请先安装: https://bun.sh"
    exit 1
fi

if ! command -v ngrok &> /dev/null; then
    echo "❌ ngrok 未安装，请先安装: https://ngrok.com"
    exit 1
fi

echo "✅ 依赖检查通过"
echo ""

# 检查环境变量
if [ ! -f ".env" ]; then
    echo "⚠️  .env 文件不存在，从 .env.example 复制..."
    cp .env.example .env
    echo "❗ 请编辑 .env 文件，填入你的 Supabase 配置"
    echo ""
    read -p "按 Enter 继续（确认已配置 .env）..."
fi

# 启动路由服务
echo "🚀 启动路由服务..."
bun run dev &
ROUTER_PID=$!

# 等待服务启动
sleep 2

# 检查服务是否启动
if ! curl -s http://localhost:3001/health > /dev/null; then
    echo "❌ 路由服务启动失败"
    kill $ROUTER_PID 2>/dev/null || true
    exit 1
fi

echo "✅ 路由服务已启动 (PID: $ROUTER_PID)"
echo ""

# 启动 ngrok
echo "🌐 启动 ngrok..."
ngrok http 3001 > /dev/null &
NGROK_PID=$!

# 等待 ngrok 启动
sleep 3

# 获取 ngrok URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*\.ngrok[^"]*' | head -1)

if [ -z "$NGROK_URL" ]; then
    echo "❌ 无法获取 ngrok URL"
    kill $ROUTER_PID $NGROK_PID 2>/dev/null || true
    exit 1
fi

echo "✅ ngrok 已启动: $NGROK_URL"
echo ""

# 配置 Telegram webhook
echo "🔧 配置 Telegram Bot Webhook..."
BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN .env | cut -d '=' -f2)
WEBHOOK_SECRET=$(grep TELEGRAM_WEBHOOK_SECRET .env | cut -d '=' -f2)

WEBHOOK_RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${NGROK_URL}/webhook/telegram\",
    \"secret_token\": \"${WEBHOOK_SECRET}\"
  }")

if echo "$WEBHOOK_RESPONSE" | grep -q '"ok":true'; then
    echo "✅ Webhook 配置成功"
else
    echo "❌ Webhook 配置失败: $WEBHOOK_RESPONSE"
    kill $ROUTER_PID $NGROK_PID 2>/dev/null || true
    exit 1
fi

echo ""
echo "================================"
echo "✅ 测试环境已就绪！"
echo ""
echo "📱 现在可以在 Telegram 中给 bot 发消息测试"
echo "📊 查看日志输出以监控消息流转"
echo ""
echo "🛑 按 Ctrl+C 停止测试"
echo "================================"
echo ""

# 等待用户中断
trap "echo ''; echo '🛑 停止服务...'; kill $ROUTER_PID $NGROK_PID 2>/dev/null || true; exit 0" INT

# 保持脚本运行
wait $ROUTER_PID
