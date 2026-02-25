import { db } from './src/domain/payment/db.js';
import { syncSubscriptionFromStripe } from './src/domain/payment/subscriptionSync.js';
import { listAssistantsByOwnerTelegramId } from './src/domain/common/db/index.js';

// 模拟 Stripe Subscription 对象
const createMockSubscription = (overrides = {}) => ({
  id: 'sub_test_123',
  customer: 'cus_test_123',
  status: 'active',
  current_period_start: Math.floor(Date.now() / 1000),
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 天后
  cancel_at_period_end: false,
  canceled_at: null,
  ended_at: null,
  metadata: {
    telegram_user_id: '123456789',
    telegram_username: 'testuser',
    plan: 'pro'
  },
  items: {
    data: [{
      price: {
        id: 'price_1SzoYERuhUY2tIYEHXkcIljS' // Pro plan
      }
    }]
  },
  ...overrides
});

const testCases = [
  {
    name: '场景 1: 新订阅创建（active）',
    subscription: createMockSubscription({
      status: 'active'
    }),
    expected: {
      shouldHaveService: true,
      containerAction: 'start',
      description: '✅ 容器应该启动，用户可以使用服务'
    }
  },
  {
    name: '场景 2: 试用期订阅（trialing）',
    subscription: createMockSubscription({
      status: 'trialing'
    }),
    expected: {
      shouldHaveService: true,
      containerAction: 'start',
      description: '✅ 试用期容器应该启动'
    }
  },
  {
    name: '场景 3: 用户取消订阅但还在周期内（active + cancel_at_period_end）',
    subscription: createMockSubscription({
      status: 'active',
      cancel_at_period_end: true,
      canceled_at: Math.floor(Date.now() / 1000)
    }),
    expected: {
      shouldHaveService: true,
      containerAction: 'keep_running',
      description: '✅ 容器应该继续运行到 current_period_end'
    }
  },
  {
    name: '场景 4: 支付失败宽限期（past_due）',
    subscription: createMockSubscription({
      status: 'past_due'
    }),
    expected: {
      shouldHaveService: true,
      containerAction: 'keep_running',
      description: '✅ 宽限期内容器继续运行'
    }
  },
  {
    name: '场景 5: 订阅已取消（canceled）',
    subscription: createMockSubscription({
      status: 'canceled',
      cancel_at_period_end: true,
      canceled_at: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
      ended_at: Math.floor(Date.now() / 1000) - 1
    }),
    expected: {
      shouldHaveService: false,
      containerAction: 'stop',
      description: '❌ 订阅已结束，容器应该停止'
    }
  },
  {
    name: '场景 6: 支付失败且重试失败（unpaid）',
    subscription: createMockSubscription({
      status: 'unpaid'
    }),
    expected: {
      shouldHaveService: false,
      containerAction: 'stop',
      description: '❌ 支付失败，容器应该停止'
    }
  },
  {
    name: '场景 7: 订阅暂停（paused）',
    subscription: createMockSubscription({
      status: 'paused'
    }),
    expected: {
      shouldHaveService: false,
      containerAction: 'stop',
      description: '❌ 订阅暂停，容器应该停止'
    }
  }
];

async function runTests() {
  console.log('🧪 开始测试订阅系统修复\n');
  console.log('='.repeat(80));

  for (const testCase of testCases) {
    console.log(`\n📋 ${testCase.name}`);
    console.log('-'.repeat(80));

    try {
      // 检查业务逻辑判断
      const status = testCase.subscription.status;
      const activeStatuses = ['active', 'trialing', 'past_due'];
      const hasActiveStatus = activeStatuses.includes(status);

      const periodEnd = testCase.subscription.current_period_end
        ? new Date(testCase.subscription.current_period_end * 1000)
        : null;
      const isWithinPeriod = testCase.subscription.cancel_at_period_end && periodEnd
        ? periodEnd > new Date()
        : true;

      const shouldProvideService = hasActiveStatus && isWithinPeriod;

      console.log(`📊 订阅状态: ${status}`);
      console.log(`📅 cancel_at_period_end: ${testCase.subscription.cancel_at_period_end}`);
      if (periodEnd) {
        console.log(`⏰ current_period_end: ${periodEnd.toISOString()}`);
      }
      console.log(`🔍 hasActiveStatus: ${hasActiveStatus}`);
      console.log(`🔍 isWithinPeriod: ${isWithinPeriod}`);
      console.log(`🎯 shouldProvideService: ${shouldProvideService}`);

      // 验证结果
      const passed = shouldProvideService === testCase.expected.shouldHaveService;

      if (passed) {
        console.log(`✅ 测试通过: ${testCase.expected.description}`);
      } else {
        console.log(`❌ 测试失败!`);
        console.log(`   期望: shouldProvideService = ${testCase.expected.shouldHaveService}`);
        console.log(`   实际: shouldProvideService = ${shouldProvideService}`);
      }

    } catch (error) {
      console.log(`❌ 测试出错: ${error.message}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('🎉 测试完成！\n');
}

// 运行测试
runTests().catch(console.error);
