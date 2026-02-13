import type { Context } from 'grammy';

export const startTypingLoop = (ctx: Context): (() => void) => {
  let typingTimer: NodeJS.Timeout | null = null;

  const sendTyping = (): Promise<unknown> => ctx.replyWithChatAction('typing').catch(() => undefined);
  void sendTyping();
  typingTimer = setInterval(() => {
    void sendTyping();
  }, 4000);

  return () => {
    if (!typingTimer) return;
    clearInterval(typingTimer);
    typingTimer = null;
  };
};
