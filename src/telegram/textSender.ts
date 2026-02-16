import { TELEGRAM_PARSE_ERROR_RE } from './constants.js';
import { renderTelegramHtmlFromMarkdown } from './format.js';
import { chunkTelegramText } from './text.js';

interface TelegramTextSendOptions {
  parse_mode?: 'HTML';
}

export type TelegramTextSender = (
  text: string,
  options?: TelegramTextSendOptions
) => Promise<unknown>;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

export const sendMarkdownText = async (send: TelegramTextSender, text: string): Promise<void> => {
  const html = renderTelegramHtmlFromMarkdown(text);
  try {
    await send(html, { parse_mode: 'HTML' });
    return;
  } catch (error: unknown) {
    if (!TELEGRAM_PARSE_ERROR_RE.test(toErrorMessage(error))) {
      throw error;
    }
  }

  await send(text);
};

export const sendChunkedMarkdownText = async (send: TelegramTextSender, text: string): Promise<void> => {
  const chunks = chunkTelegramText(text);
  for (const chunk of chunks) {
    await sendMarkdownText(send, chunk);
  }
};
