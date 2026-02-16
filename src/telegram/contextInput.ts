import type { Context } from 'grammy';
import { type ParsedTelegramInput, parseTelegramInput } from './input.js';

const mergeParsedInputs = (parsedInputs: ParsedTelegramInput[]): ParsedTelegramInput | null => {
  if (parsedInputs.length === 0) return null;

  const textParts = parsedInputs.map((item) => item.text.trim()).filter(Boolean);
  const attachments = parsedInputs.flatMap((item) => item.attachments);
  const text = textParts.join('\n').trim() || 'Please process these attachments.';

  return {
    text,
    attachments
  };
};

export const parseInputsFromContexts = async (
  contexts: Context[],
  botToken: string,
  telegramUserId: number
): Promise<ParsedTelegramInput | null> => {
  const parsedInputs = (
    await Promise.all(contexts.map((ctx) => parseTelegramInput(ctx, botToken, telegramUserId)))
  ).filter((parsed): parsed is ParsedTelegramInput => Boolean(parsed));

  return mergeParsedInputs(parsedInputs);
};

export const pickPrimaryContext = (contexts: Context[]): Context | null => {
  if (contexts.length === 0) return null;

  const withText = contexts.find((ctx) => {
    const text = typeof ctx.message?.text === 'string' ? ctx.message.text : '';
    const caption = typeof ctx.message?.caption === 'string' ? ctx.message.caption : '';
    return Boolean(text.trim() || caption.trim());
  });

  return withText ?? contexts[0] ?? null;
};
