#!/bin/bash

# Stripe 测试事件触发脚本

echo "🚀 Stripe Webhook 测试"
echo "======================"
echo ""

DB_URL="postgresql://heyuehui@localhost:5432/pinai_assistant"

# 检查 Stripe CLI
if ! command -v stripe &> /dev/null; then
    echo "❌ Stripe CLI 未安装，请先运行: ./stripe_test_guide.sh"
    exit 1
fi

echo "⚠️  确保以下服务正在运行:"
echo "  1. API 服务 (终端 1): cd apis && npm run dev"
echo "  2. Stripe CLI (终端 2): stripe listen --forward-to http://localhost:3000/api/payment/webhook"
echo ""
read -p "都准备好了吗？按 Enter 继续..."
echo ""

# 测试 1: 创建订阅
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 测试 1: 创建新订阅 (customer.subscription.created)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "触发事件..."
stripe trigger customer.subscription.created
echo ""
echo "等待处理..."
sleep 3
echo ""
echo "查询结果:"
psql "$DB_URL" -c "
SELECT
  id,
  status,
  stripe_status,
  cancel_at_period_end,
  TO_CHAR(updated_at, 'HH24:MI:SS') as time
FROM user_subscriptions
ORDER BY updated_at DESC
LIMIT 1;
" 2>/dev/null || echo "⚠️  数据库查询失败，请检查连接"
echo ""
read -p "按 Enter 继续..."
echo ""

# 测试 2: 订阅更新
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 测试 2: 订阅更新 (customer.subscription.updated)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "触发事件..."
stripe trigger customer.subscription.updated
echo ""
echo "等待处理..."
sleep 3
echo ""
echo "查询结果:"
psql "$DB_URL" -c "
SELECT
  id,
  status,
  stripe_status,
  cancel_at_period_end,
  TO_CHAR(updated_at, 'HH24:MI:SS') as time
FROM user_subscriptions
ORDER BY updated_at DESC
LIMIT 1;
" 2>/dev/null
echo ""
read -p "按 Enter 继续..."
echo ""

# 测试 3: 支付成功
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 测试 3: 支付成功 (invoice.paid)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "触发事件..."
stripe trigger invoice.paid
echo ""
echo "等待处理..."
sleep 3
echo ""
echo "查询结果:"
psql "$DB_URL" -c "
SELECT
  id,
  status,
  TO_CHAR(current_period_start, 'MM-DD') as start,
  TO_CHAR(current_period_end, 'MM-DD') as end,
  TO_CHAR(updated_at, 'HH24:MI:SS') as time
FROM user_subscriptions
ORDER BY updated_at DESC
LIMIT 1;
" 2>/dev/null
echo ""
read -p "按 Enter 继续..."
echo ""

# 测试 4: 支付失败
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 测试 4: 支付失败 (invoice.payment_failed) ⭐"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "触发事件..."
stripe trigger invoice.payment_failed
echo ""
echo "等待处理..."
sleep 3
echo ""
echo "查询结果 (应该看到 past_due 状态):"
psql "$DB_URL" -c "
SELECT
  id,
  status,
  stripe_status,
  CASE
    WHEN status IN ('active', 'trialing', 'past_due') THEN '✅ 继续服务'
    ELSE '❌ 停止服务'
  END as should_serve,
  TO_CHAR(updated_at, 'HH24:MI:SS') as time
FROM user_subscriptions
ORDER BY updated_at DESC
LIMIT 1;
" 2>/dev/null
echo ""
read -p "按 Enter 继续..."
echo ""

# 测试 5: 订阅删除
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 测试 5: 订阅删除 (customer.subscription.deleted)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "触发事件..."
stripe trigger customer.subscription.deleted
echo ""
echo "等待处理..."
sleep 3
echo ""
echo "查询结果 (应该看到 canceled 状态):"
psql "$DB_URL" -c "
SELECT
  id,
  status,
  stripe_status,
  cancel_at_period_end,
  ended_at,
  CASE
    WHEN status IN ('active', 'trialing', 'past_due') THEN '✅ 继续服务'
    ELSE '❌ 停止服务'
  END as should_serve,
  TO_CHAR(updated_at, 'HH24:MI:SS') as time
FROM user_subscriptions
ORDER BY updated_at DESC
LIMIT 1;
" 2>/dev/null
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 所有测试完成！"
echo ""
echo "📊 查看事件历史:"
psql "$DB_URL" -c "
SELECT
  event_type,
  processing_status,
  TO_CHAR(created_at, 'HH24:MI:SS') as time
FROM payment_events
ORDER BY created_at DESC
LIMIT 10;
" 2>/dev/null
echo ""
echo "💡 提示: 查看终端 1 (API) 和终端 2 (Stripe CLI) 的日志以获取详细信息"
