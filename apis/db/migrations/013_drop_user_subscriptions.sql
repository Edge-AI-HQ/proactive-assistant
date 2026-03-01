-- 删除 user_subscriptions 表
-- 现在使用 subscription_periods 表按时间范围判断当前生效周期

-- 删除表（CASCADE 会删除相关的外键约束）
DROP TABLE IF EXISTS user_subscriptions CASCADE;

COMMENT ON TABLE subscription_periods IS 'Stripe 订阅计费周期；替代 user_subscriptions，用时间范围判断当前生效周期';
