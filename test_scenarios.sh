#!/bin/bash

# 订阅系统完整测试脚本

echo "🧪 订阅系统完整测试"
echo "===================="
echo ""

DB_URL="postgresql://heyuehui@localhost:5432/pinai_assistant"
TEST_USER_ID="999999999"

echo "📝 准备测试环境..."
echo ""

# 创建测试数据
psql "$DB_URL" << EOF
-- 清理旧的测试数据
DELETE FROM user_subscriptions WHERE user_id IN (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
DELETE FROM users WHERE telegram_user_id = $TEST_USER_ID;

-- 创建测试用户
INSERT INTO users (telegram_user_id, telegram_username, gateway_token)
VALUES ($TEST_USER_ID, 'test_user', 'test_gateway_token_123')
ON CONFLICT (telegram_user_id) DO NOTHING;

-- 创建测试订阅
INSERT INTO user_subscriptions (
  user_id,
  stripe_customer_id,
  stripe_subscription_id,
  plan_id,
  status,
  cancel_at_period_end,
  current_period_start,
  current_period_end
)
SELECT
  id,
  'cus_test_123',
  'sub_test_123',
  'pro',
  'active',
  false,
  NOW(),
  NOW() + INTERVAL '30 days'
FROM users WHERE telegram_user_id = $TEST_USER_ID
ON CONFLICT (user_id) DO UPDATE SET
  status = 'active',
  cancel_at_period_end = false,
  current_period_start = NOW(),
  current_period_end = NOW() + INTERVAL '30 days';
EOF

echo "✅ 测试环境准备完成"
echo ""

# 测试场景 1
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 场景 1: Active 订阅"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
psql "$DB_URL" << EOF
UPDATE user_subscriptions
SET status = 'active', stripe_status = 'active', cancel_at_period_end = false,
    current_period_end = NOW() + INTERVAL '30 days', ended_at = NULL
WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);

SELECT
  '状态' as "字段", status as "值"
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT 'cancel_at_period_end', cancel_at_period_end::text
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '周期是否有效', (current_period_end > NOW())::text
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '判断结果',
  CASE
    WHEN status IN ('active', 'trialing', 'past_due')
      AND (NOT cancel_at_period_end OR current_period_end > NOW())
    THEN '✅ 应该提供服务'
    ELSE '❌ 不应该提供服务'
  END
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
EOF
echo ""

# 测试场景 2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 场景 2: Trialing 订阅（试用期）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
psql "$DB_URL" << EOF
UPDATE user_subscriptions
SET status = 'trialing', stripe_status = 'trialing', cancel_at_period_end = false
WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);

SELECT
  '状态' as "字段", status as "值"
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '判断结果',
  CASE
    WHEN status IN ('active', 'trialing', 'past_due')
      AND (NOT cancel_at_period_end OR current_period_end > NOW())
    THEN '✅ 应该提供服务（试用期）'
    ELSE '❌ 不应该提供服务'
  END
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
EOF
echo ""

# 测试场景 3
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 场景 3: 用户取消订阅但还在周期内 ⭐ 关键测试"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
psql "$DB_URL" << EOF
UPDATE user_subscriptions
SET status = 'active', stripe_status = 'active', cancel_at_period_end = true,
    current_period_end = NOW() + INTERVAL '15 days'
WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);

SELECT
  '状态' as "字段", status as "值"
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT 'cancel_at_period_end', cancel_at_period_end::text
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '周期结束时间', TO_CHAR(current_period_end, 'YYYY-MM-DD HH24:MI:SS')
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '还在周期内', (current_period_end > NOW())::text
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '判断结果',
  CASE
    WHEN status IN ('active', 'trialing', 'past_due')
      AND (NOT cancel_at_period_end OR current_period_end > NOW())
    THEN '✅ 应该继续提供服务到周期结束'
    ELSE '❌ 不应该提供服务'
  END
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
EOF
echo ""

# 测试场景 4
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 场景 4: Past Due（支付失败宽限期）⭐ 关键测试"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
psql "$DB_URL" << EOF
UPDATE user_subscriptions
SET status = 'past_due', stripe_status = 'past_due', cancel_at_period_end = false
WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);

SELECT
  '状态' as "字段", status as "值"
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '判断结果',
  CASE
    WHEN status IN ('active', 'trialing', 'past_due')
      AND (NOT cancel_at_period_end OR current_period_end > NOW())
    THEN '✅ 应该提供服务（宽限期）'
    ELSE '❌ 不应该提供服务'
  END
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
EOF
echo ""

# 测试场景 5
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 场景 5: Canceled（订阅已取消）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
psql "$DB_URL" << EOF
UPDATE user_subscriptions
SET status = 'canceled', stripe_status = 'canceled', cancel_at_period_end = true,
    ended_at = NOW() - INTERVAL '1 day'
WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);

SELECT
  '状态' as "字段", status as "值"
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '判断结果',
  CASE
    WHEN status IN ('active', 'trialing', 'past_due')
      AND (NOT cancel_at_period_end OR current_period_end > NOW())
    THEN '✅ 应该提供服务'
    ELSE '❌ 不应该提供服务（已取消）'
  END
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
EOF
echo ""

# 测试场景 6
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 场景 6: Unpaid（支付失败）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
psql "$DB_URL" << EOF
UPDATE user_subscriptions
SET status = 'unpaid', stripe_status = 'unpaid', cancel_at_period_end = false
WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);

SELECT
  '状态' as "字段", status as "值"
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '判断结果',
  CASE
    WHEN status IN ('active', 'trialing', 'past_due')
      AND (NOT cancel_at_period_end OR current_period_end > NOW())
    THEN '✅ 应该提供服务'
    ELSE '❌ 不应该提供服务（支付失败）'
  END
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
EOF
echo ""

# 测试场景 7
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 场景 7: 周期已过期但 cancel_at_period_end=true"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
psql "$DB_URL" << EOF
UPDATE user_subscriptions
SET status = 'active', stripe_status = 'active', cancel_at_period_end = true,
    current_period_end = NOW() - INTERVAL '1 day'
WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);

SELECT
  '状态' as "字段", status as "值"
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT 'cancel_at_period_end', cancel_at_period_end::text
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '周期是否有效', (current_period_end > NOW())::text
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID)
UNION ALL
SELECT '判断结果',
  CASE
    WHEN status IN ('active', 'trialing', 'past_due')
      AND (NOT cancel_at_period_end OR current_period_end > NOW())
    THEN '✅ 应该提供服务'
    ELSE '❌ 不应该提供服务（周期已过）'
  END
FROM user_subscriptions WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
EOF
echo ""

# 清理
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧹 清理测试数据..."
psql "$DB_URL" << EOF
DELETE FROM user_subscriptions WHERE user_id IN (SELECT id FROM users WHERE telegram_user_id = $TEST_USER_ID);
DELETE FROM users WHERE telegram_user_id = $TEST_USER_ID;
EOF

echo ""
echo "✅ 所有测试完成！"
echo ""
echo "📊 测试总结："
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Active 订阅 → 应该提供服务"
echo "✅ Trialing 订阅 → 应该提供服务"
echo "✅ 取消但还在周期内 → 应该继续提供服务 ⭐"
echo "✅ Past Due 宽限期 → 应该继续提供服务 ⭐"
echo "❌ Canceled 订阅 → 不应该提供服务"
echo "❌ Unpaid 订阅 → 不应该提供服务"
echo "❌ 周期已过期 → 不应该提供服务"
