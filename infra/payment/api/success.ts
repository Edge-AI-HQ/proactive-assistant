import { VercelRequest, VercelResponse } from '@vercel/node';

const readBotLink = (): string | null => {
  const username = (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  if (!username) return null;
  return `https://t.me/${username}`;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const botLink = readBotLink();
  const button = botLink
    ? `<a class="button" href="${botLink}" target="_blank" rel="noopener">Return to Telegram</a>`
    : `<p class="muted">Return to Telegram and continue with your bot.</p>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subscription Active</title>
    <style>
      :root {
        --bg: #f6f9f8;
        --card: #ffffff;
        --text: #102118;
        --muted: #4f665a;
        --ok: #1f9e61;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 12% 10%, rgba(31, 158, 97, 0.18), transparent 30%),
          radial-gradient(circle at 88% 85%, rgba(76, 54, 216, 0.10), transparent 32%),
          var(--bg);
        color: var(--text);
        padding: 24px;
      }
      .card {
        width: min(620px, 100%);
        background: var(--card);
        border-radius: 18px;
        padding: 34px;
        box-shadow: 0 16px 42px rgba(18, 36, 27, 0.14);
      }
      .badge {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.3px;
        color: #fff;
        background: var(--ok);
      }
      h1 { margin: 14px 0 12px; font-size: 34px; }
      p { margin: 0 0 16px; color: var(--muted); line-height: 1.6; }
      ul { margin: 0 0 22px; color: #244537; line-height: 1.65; padding-left: 18px; }
      .button {
        display: inline-block;
        text-decoration: none;
        padding: 12px 18px;
        border-radius: 12px;
        color: #fff;
        font-weight: 600;
        background: #3c31ce;
      }
      .muted { margin: 0; }
    </style>
  </head>
  <body>
    <main class="card">
      <span class="badge">PAYMENT SUCCESS</span>
      <h1>Subscription Activated</h1>
      <p>Your payment was completed successfully.</p>
      <ul>
        <li>Your subscription status is now active.</li>
        <li>Credits are refreshed based on your daily/monthly cycle rules.</li>
        <li>You can continue directly from Telegram.</li>
      </ul>
      ${button}
    </main>
  </body>
</html>
  `);
}

