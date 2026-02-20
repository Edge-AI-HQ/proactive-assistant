import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Markup, Telegraf } from 'telegraf';
import { paymentBackendClient } from '../../lib/paymentBackendClient.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

const createPaymentLink = async (userId: string, username?: string): Promise<string> => {
  const session = await paymentBackendClient.createPaymentSession(userId, username ?? null);
  return session.subscribe_url;
};

bot.command('start', async (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;

  try {
    const subscribeUrl = await createPaymentLink(userId, username);

    await ctx.reply(
      `👋 Welcome to OpenClaw Cloud!

🎮 Cloud-hosted OpenClaw game engine
☁️ Dedicated containers for your projects

Click below to choose your plan:`,
      Markup.inlineKeyboard([[Markup.button.url('💳 Subscribe', subscribeUrl)]])
    );
  } catch (error: unknown) {
    console.error('Start command error:', error);
    await ctx.reply('❌ Failed to generate payment link. Please try again.');
  }
});

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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Telegram webhook error:', error);
    res.status(500).json({ error: message });
  }
}
