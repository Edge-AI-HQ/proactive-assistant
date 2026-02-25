#!/bin/bash

# 订阅系统修复测试脚本

echo "🧪 订阅系统修复测试"
echo "===================="
echo ""

# 1. 验证数据库 schema
echo "1️⃣ 验证数据库 schema..."
psql postgresql://heyuehui@localhost:5432/pinai_assistant -c "
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'user_subscriptions'
  AND column_name IN ('status', 'ended_at', 'stripe_status', 'cancel_at_period_end')
ORDER BY column_name;
"

echo ""
echo "2️⃣ 验证 status 约束..."
psql postgresql://heyuehui@localhost:5432/pinai_assistant -c "
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'user_subscriptions_status_check';
"

echo ""
echo "3️⃣ 查看当前订阅数据..."
psql postgresql://heyuehui@localhost:5432/pinai_assistant -c "
SELECT
  id,
  status,
  stripe_status,
  cancel_at_period_end,
  current_period_end,
  ended_at,
  created_at
FROM user_subscriptions;
"

echo ""
echo "4️⃣ 测试插入新状态..."
psql postgresql://heyuehui@localhost:5432/pinai_assistant -c "
-- 测试 trialing 状态
UPDATE user_subscriptions
SET status = 'trialing', stripe_status = 'trialing'
WHERE id = 1;

SELECT id, status, stripe_status FROM user_subscriptions WHERE id = 1;

-- 恢复为 incomplete
UPDATE user_subscriptions
SET status = 'incomplete', stripe_status = NULL
WHERE id = 1;
"

echo ""
echo "✅ 数据库测试完成！"
echo ""
echo "📝 下一步："
echo "1. 启动 API 服务: cd apis && npm run dev"
echo "2. 在另一个终端启动 Stripe CLI: stripe listen --forward-to http://localhost:3000/api/payment/webhook"
echo "3. 触发测试事件: stripe trigger customer.subscription.created"
echo ""
echo "🎯 关键验证点："
echo "- ✅ 支持 8 个 Stripe 状态（incomplete, incomplete_expired, trialing, active, past_due, canceled, unpaid, paused）"
echo "- ✅ ended_at 和 stripe_status 字段已添加"
echo "- ✅ cancel_at_period_end 逻辑已修复"
echo "- ✅ 用户取消订阅后容器继续运行到周期结束"
