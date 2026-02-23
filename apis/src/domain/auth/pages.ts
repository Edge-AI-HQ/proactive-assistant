const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const renderSimplePageHtml = (title: string, message: string): string => {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:ui-sans-serif,system-ui;max-width:680px;margin:40px auto;padding:16px;">
  <h2>${title}</h2><p>${message}</p></body></html>`;
};

export const renderGatewayTelegramLoginPageHtml = (params: {
  telegramUserId: number;
  botUsername: string;
  callbackUrl: string;
}): string => {
  const { telegramUserId, botUsername, callbackUrl } = params;
  const escapedBotUsername = escapeHtml(botUsername);
  const escapedCallback = escapeHtml(callbackUrl);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Telegram Login Required</title>
  </head>
  <body style="font-family:ui-sans-serif,system-ui;max-width:680px;margin:40px auto;padding:16px;line-height:1.5;">
    <h2>Sign in with Telegram</h2>
    <p>Please sign in with Telegram account <strong>${telegramUserId}</strong> to continue.</p>
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${escapedBotUsername}"
      data-size="large"
      data-auth-url="${escapedCallback}"
      data-request-access="write"></script>
    <p style="margin-top:16px;color:#475569;">After login, you will be redirected to the Gateway dashboard automatically. For one-tap login inside Telegram app, use the /gateway command in your bot chat.</p>
  </body>
</html>`;
};
