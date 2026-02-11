import type { Context } from 'grammy';
import { renderTelegramHtmlFromMarkdown } from './format.js';

const TELEGRAM_EDIT_NOOP_ERROR_RE = /message is not modified/i;
const TELEGRAM_PARSE_ERROR_RE = /can't parse entities|parse entities|find end of the entity/i;
const DEFAULT_THROTTLE_MS = 500;
const DEFAULT_MAX_CHARS = 3900;

export interface TelegramStreamFinalizeResult {
  streamed: boolean;
  overflowed: boolean;
}

export interface TelegramTextStream {
  update: (text: string) => void;
  finalize: (finalText: string) => Promise<TelegramStreamFinalizeResult>;
  discard: () => Promise<void>;
  stop: () => void;
}

const wait = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

export const createTelegramTextStream = (params: {
  ctx: Context;
  throttleMs?: number;
  maxChars?: number;
  onFirstRender?: () => void;
  onWarn?: (message: string) => void;
}): TelegramTextStream => {
  const chatId = params.ctx.chat?.id;
  if (chatId === undefined || chatId === null) {
    return {
      update: () => undefined,
      finalize: async () => ({ streamed: false, overflowed: false }),
      discard: async () => undefined,
      stop: () => undefined
    };
  }

  const throttleMs = Math.max(50, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const maxChars = Math.max(256, params.maxChars ?? DEFAULT_MAX_CHARS);

  let stopped = false;
  let overflowed = false;
  let messageId: number | null = null;
  let lastSentText = '';
  let lastSentAt = 0;
  let pendingText = '';
  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    stopped = true;
    pendingText = '';
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    if (stopped || timer) return;
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const sendOrEdit = async (raw: string): Promise<void> => {
    if (stopped) return;

    const text = raw.trimEnd();
    if (!text) return;

    if (text.length > maxChars) {
      overflowed = true;
      stop();
      return;
    }

    if (text === lastSentText) {
      return;
    }

    lastSentText = text;
    lastSentAt = Date.now();

    const sendHtml = async (): Promise<void> => {
      const html = renderTelegramHtmlFromMarkdown(text);
      if (messageId === null) {
        const sent = await params.ctx.reply(html, {
          parse_mode: 'HTML'
        });
        messageId = sent.message_id;
        params.onFirstRender?.();
        return;
      }

      await params.ctx.api.editMessageText(chatId, messageId, html, {
        parse_mode: 'HTML'
      });
    };

    const sendPlain = async (): Promise<void> => {
      if (messageId === null) {
        const sent = await params.ctx.reply(text);
        messageId = sent.message_id;
        params.onFirstRender?.();
        return;
      }

      await params.ctx.api.editMessageText(chatId, messageId, text);
    };

    const tryPlainFallback = async (reason: string): Promise<void> => {
      try {
        await sendPlain();
      } catch (fallbackError: unknown) {
        const fallbackMessage = toErrorMessage(fallbackError);
        if (TELEGRAM_EDIT_NOOP_ERROR_RE.test(fallbackMessage)) {
          return;
        }
        params.onWarn?.(`telegram stream update failed (${reason}): ${fallbackMessage}`);
        stop();
      }
    };

    try {
      await sendHtml();
      return;
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      if (TELEGRAM_EDIT_NOOP_ERROR_RE.test(message)) {
        return;
      }
      if (TELEGRAM_PARSE_ERROR_RE.test(message)) {
        await tryPlainFallback('html-parse');
        return;
      }
      await tryPlainFallback('html-send');
    }
  };

  const flush = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      schedule();
      return;
    }

    const text = pendingText;
    if (!text.trim()) {
      pendingText = '';
      return;
    }

    pendingText = '';
    inFlight = true;
    try {
      await sendOrEdit(text);
    } finally {
      inFlight = false;
    }

    if (!stopped && pendingText) {
      schedule();
    }
  };

  const waitUntilSettled = async (): Promise<void> => {
    while (inFlight) {
      await wait(20);
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
      await flush();
      while (inFlight) {
        await wait(20);
      }
    }
  };

  return {
    update: (text: string): void => {
      if (stopped) return;
      const trimmed = text.trimEnd();
      if (!trimmed) return;
      if (trimmed.length > maxChars) {
        overflowed = true;
        stop();
        return;
      }

      pendingText = trimmed;
      if (inFlight) {
        schedule();
        return;
      }

      if (Date.now() - lastSentAt >= throttleMs && !timer) {
        void flush();
        return;
      }

      schedule();
    },
    finalize: async (finalText: string): Promise<TelegramStreamFinalizeResult> => {
      if (!overflowed) {
        const trimmedFinal = finalText.trimEnd();
        if (trimmedFinal.length > maxChars) {
          overflowed = true;
        } else if (trimmedFinal) {
          pendingText = trimmedFinal;
        }
      }

      if (!overflowed) {
        await waitUntilSettled();
        await flush();
        await waitUntilSettled();
      }

      const result: TelegramStreamFinalizeResult = {
        streamed: messageId !== null,
        overflowed
      };
      stop();
      return result;
    },
    discard: async (): Promise<void> => {
      stop();
      if (messageId === null) return;
      await params.ctx.api.deleteMessage(chatId, messageId).catch(() => undefined);
      messageId = null;
      lastSentText = '';
    },
    stop
  };
};
