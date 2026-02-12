import { Telegraf, Markup } from 'telegraf';
import { db } from './supabase';
import { stripeService } from './stripe';
import { dockerService } from './docker';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

// 启动命令
bot.command('start', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;

  await ctx.reply(
    `👋 欢迎使用 OpenClaw Cloud！

🎮 OpenClaw 是一个开源的游戏引擎
☁️ 我们为你提供云端运行环境

💰 订阅价格：$10/月
📦 包含：2GB RAM + 独立容器

点击下方按钮开始订阅：`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💳 订阅服务', 'subscribe')],
      [Markup.button.callback('ℹ️ 查看我的订阅', 'my_subscription')],
    ])
  );
});

// 订阅按钮
bot.action('subscribe', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id.toString();
  const username = ctx.from.username;

  try {
    // 检查是否已有活跃订阅
    const subscription = await db.getSubscriptionByTelegramId(userId);
    if (subscription && subscription.status === 'active') {
      await ctx.reply('✅ 你已经有活跃的订阅了！\n\n使用 /status 查看详情');
      return;
    }

    // 创建 Stripe Checkout Session
    const checkoutUrl = await stripeService.createCheckoutSession(
      userId,
      username
    );

    await ctx.reply(
      '🔗 点击下方链接完成支付：',
      Markup.inlineKeyboard([
        [Markup.button.url('💳 前往支付', checkoutUrl)],
      ])
    );
  } catch (error: any) {
    console.error('Subscribe error:', error);
    await ctx.reply('❌ 创建订阅失败，请稍后重试');
  }
});

// 查看订阅状态
bot.action('my_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  await handleStatus(ctx);
});

bot.command('status', async (ctx) => {
  await handleStatus(ctx);
});

async function handleStatus(ctx: any) {
  const userId = ctx.from.id.toString();

  try {
    const subscription = await db.getSubscriptionByTelegramId(userId);

    if (!subscription) {
      await ctx.reply(
        '❌ 你还没有订阅\n\n使用 /start 开始订阅',
        Markup.inlineKeyboard([
          [Markup.button.callback('💳 立即订阅', 'subscribe')],
        ])
      );
      return;
    }

    let statusEmoji = '⏳';
    let statusText = '待激活';

    switch (subscription.status) {
      case 'active':
        statusEmoji = '✅';
        statusText = '活跃';
        break;
      case 'paused':
        statusEmoji = '⏸️';
        statusText = '已暂停';
        break;
      case 'canceled':
        statusEmoji = '❌';
        statusText = '已取消';
        break;
    }

    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end).toLocaleDateString('zh-CN')
      : '未知';

    let message = `${statusEmoji} 订阅状态：${statusText}\n\n`;

    if (subscription.status === 'active') {
      message += `🔗 访问地址：${subscription.docker_url || '正在启动...'}\n`;
      message += `📅 下次续费：${periodEnd}\n`;
    } else if (subscription.status === 'pending') {
      message += `⏳ 正在等待支付完成...\n`;
    } else {
      message += `📅 到期时间：${periodEnd}\n`;
    }

    const buttons = [];

    if (subscription.status === 'active') {
      buttons.push([Markup.button.callback('🔄 重启容器', 'restart_container')]);
      buttons.push([Markup.button.callback('⚙️ 管理订阅', 'manage_subscription')]);
    } else if (subscription.status === 'canceled') {
      buttons.push([Markup.button.callback('💳 重新订阅', 'subscribe')]);
    }

    await ctx.reply(message, Markup.inlineKeyboard(buttons));
  } catch (error: any) {
    console.error('Status error:', error);
    await ctx.reply('❌ 获取订阅状态失败');
  }
}

// 重启容器
bot.action('restart_container', async (ctx) => {
  await ctx.answerCbQuery('正在重启容器...');

  const userId = ctx.from.id.toString();

  try {
    const subscription = await db.getSubscriptionByTelegramId(userId);

    if (!subscription?.docker_container_id) {
      await ctx.reply('❌ 容器不存在');
      return;
    }

    await dockerService.stopContainer(subscription.docker_container_id, userId);
    await dockerService.startContainer(subscription.docker_container_id, userId);

    await ctx.reply('✅ 容器已重启');
  } catch (error: any) {
    console.error('Restart error:', error);
    await ctx.reply('❌ 重启失败，请联系客服');
  }
});

// 管理订阅（跳转到 Stripe 客户门户）
bot.action('manage_subscription', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = ctx.from.id.toString();

  try {
    const subscription = await db.getSubscriptionByTelegramId(userId);

    if (!subscription?.stripe_customer_id) {
      await ctx.reply('❌ 未找到订阅信息');
      return;
    }

    const portalUrl = await stripeService.createPortalSession(
      subscription.stripe_customer_id
    );

    await ctx.reply(
      '🔗 点击下方链接管理你的订阅：\n\n' +
        '• 更新支付方式\n' +
        '• 查看账单历史\n' +
        '• 取消订阅',
      Markup.inlineKeyboard([
        [Markup.button.url('⚙️ 管理订阅', portalUrl)],
      ])
    );
  } catch (error: any) {
    console.error('Manage subscription error:', error);
    await ctx.reply('❌ 创建管理链接失败');
  }
});

// 帮助命令
bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 OpenClaw Cloud 使用指南

🎮 命令列表：
/start - 开始使用
/status - 查看订阅状态
/help - 显示帮助

💡 常见问题：
Q: 如何取消订阅？
A: 使用 /status 命令，点击"管理订阅"按钮

Q: 容器无法访问？
A: 尝试重启容器，或联系客服

Q: 如何更新支付方式？
A: 在"管理订阅"页面更新

📧 客服支持：support@example.com`
  );
});

export { bot };
