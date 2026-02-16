import { Bot, type Context } from 'grammy';
import { setOpenClawCronEventHandler, type OpenClawCronFinishedEvent } from '../openclaw/chatSessionService.js';
import { renderTelegramHtmlFromMarkdown } from './format.js';
import { TELEGRAM_PARSE_ERROR_RE } from './constants.js';
import { chunkTelegramText } from './text.js';

const sendBotText = async (bot: Bot<Context>, chatId: number, text: string): Promise<void> => {
  const html = renderTelegramHtmlFromMarkdown(text);
  try {
    await bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML'
    });
    return;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!TELEGRAM_PARSE_ERROR_RE.test(message)) {
      throw error;
    }
  }
  await bot.api.sendMessage(chatId, text);
};

const formatCronMessage = (event: OpenClawCronFinishedEvent): string => {
  const summary = event.summary?.trim();
  if (summary) return summary;
  if (event.status === 'error' && typeof event.error === 'string' && event.error.trim()) {
    return `Cron job failed: ${event.error.trim()}`;
  }
  return '';
};

export const registerTelegramCronDelivery = (bot: Bot<Context>): void => {
  setOpenClawCronEventHandler(async (event) => {
    const message = formatCronMessage(event);
    if (!message) return;

    const chunks = chunkTelegramText(message);
    for (const chunk of chunks) {
      try {
        await sendBotText(bot, event.telegramUserId, chunk);
      } catch (error: unknown) {
        console.error('Cron Telegram delivery failed', error);
        break;
      }
    }
  });
};
