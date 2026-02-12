import { VercelRequest, VercelResponse } from '@vercel/node';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// 生成支付 token
async function generatePaymentToken(userId: string, username?: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await supabase.from('payment_sessions').insert({
    token,
    telegram_user_id: userId,
    telegram_username: username,
    expires_at: expiresAt.toISOString(),
  });

  return token;
}

// 启动命令
bot.command('start', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;

  try {
    // 生成一次性支付 token
    const token = await generatePaymentToken(userId, username);
    const subscribeUrl = `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/api/subscribe?token=${token}`;

    await ctx.reply(
      `👋 Welcome to OpenClaw Cloud!

🎮 Cloud-hosted OpenClaw game engine
☁️ Dedicated containers for your projects

Click below to choose your plan:`,
      Markup.inlineKeyboard([
        [Markup.button.url('💳 Subscribe', subscribeUrl)],
      ])
    );
  } catch (error: any) {
    console.error('Start command error:', error);
    await ctx.reply('❌ Failed to generate payment link. Please try again.');
  }
});

// 帮助命令
bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 OpenClaw Cloud Help

🎮 Commands:
/start - Get started
/help - Show this help

💰 Pricing:
• Basic: $10/mo - 2GB RAM
• Pro: $20/mo - 4GB RAM
• Max: $50/mo - 8GB RAM

Use /start to subscribe`
  );
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error('Telegram webhook error:', error);
    res.status(500).json({ error: error.message });
  }
}
