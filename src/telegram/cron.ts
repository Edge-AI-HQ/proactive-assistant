import { Bot, type Context } from 'grammy';
import { setOpenClawCronEventHandler, type OpenClawCronFinishedEvent } from '../openclaw/chatSessionService.js';
import { sendChunkedMarkdownText } from './textSender.js';

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
    await sendChunkedMarkdownText(
      (text, options) => bot.api.sendMessage(event.telegramUserId, text, options),
      message
    ).catch((error: unknown) => {
      console.error('Cron Telegram delivery failed', error);
    });
  });
};
