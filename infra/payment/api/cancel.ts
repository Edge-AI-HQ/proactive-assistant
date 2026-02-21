import { VercelRequest, VercelResponse } from '@vercel/node';

const readBotLink = (): string | null => {
  const username = (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  if (!username) return null;
  return `https://t.me/${username}`;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const botLink = readBotLink();
  const button = botLink
    ? `<a class="button" href="${botLink}" target="_blank" rel="noopener">Back to Telegram</a>`
    : `<p class="muted">No charge was made. You can retry from Telegram anytime.</p>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Payment Cancelled</title>
    <style>
      :root {
        --bg: #faf7f6;
        --card: #ffffff;
        --text: #2a1b19;
        --muted: #6f5d57;
        --warn: #cb5c45;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 8% 8%, rgba(203, 92, 69, 0.16), transparent 30%),
          radial-gradient(circle at 85% 90%, rgba(76, 54, 216, 0.08), transparent 35%),
          var(--bg);
        color: var(--text);
        padding: 24px;
      }
      .card {
        width: min(580px, 100%);
        background: var(--card);
        border-radius: 18px;
        padding: 32px;
        box-shadow: 0 16px 42px rgba(48, 29, 26, 0.14);
      }
      .badge {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.3px;
        color: #fff;
        background: var(--warn);
      }
      h1 { margin: 14px 0 10px; font-size: 32px; }
      p { margin: 0 0 18px; color: var(--muted); line-height: 1.6; }
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
      <span class="badge">PAYMENT CANCELLED</span>
      <h1>Checkout Cancelled</h1>
      <p>No charge was made to your account. You can reopen subscription checkout whenever you're ready.</p>
      ${button}
    </main>
  </body>
</html>
  `);
}

