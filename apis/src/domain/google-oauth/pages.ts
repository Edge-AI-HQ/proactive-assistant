const esc = (v: unknown): string =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const renderGoogleCallbackPage = (params: {
  title: string;
  message: string;
  email?: string | null;
  botUrl?: string | null;
}): string => {
  const title = esc(params.title);
  const message = esc(params.message);
  const email = esc(params.email || '');
  const botUrl = params.botUrl?.trim() || '';
  const autoRedirectScript = botUrl
    ? `<script>setTimeout(() => { window.location.href = ${JSON.stringify(botUrl)}; }, 1200);</script>`
    : '';
  const botButton = botUrl
    ? `<a href="${esc(botUrl)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:600;">Return to Telegram</a>`
    : '';

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${title}</title>
    </head>
    <body style="font-family:ui-sans-serif,system-ui;max-width:720px;margin:40px auto;padding:16px;line-height:1.6;color:#111827;">
      <h2>${title}</h2>
      <p>${message}</p>
      ${email ? `<p><strong>Connected mailbox:</strong> <code>${email}</code></p>` : ''}
      <p>You can now ask your assistant to:</p>
      <ul>
        <li>Show your latest emails</li>
        <li>Search emails by keyword or sender</li>
        <li>Summarize unread emails</li>
        <li>Highlight emails that need a reply</li>
      </ul>
      ${botButton}
      ${autoRedirectScript}
    </body>
  </html>`;
};
