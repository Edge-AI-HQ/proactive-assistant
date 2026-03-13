const paymentPageLayoutStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --page-bg: linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(248, 238, 250, 0.92) 18%, rgba(244, 229, 246, 0.88) 34%, rgba(239, 225, 243, 0.84) 53%, rgba(223, 231, 248, 0.88) 77%, rgba(244, 245, 255, 0.96) 100%);
    --ink: #1a1630;
    --muted: #655f7f;
    --soft-line: rgba(131, 102, 164, 0.16);
    --accent: #df5bb9;
    --accent-deep: #c3479f;
    --card-shadow: 0 18px 45px rgba(78, 48, 109, 0.14);
    --card-bg: rgba(255, 255, 255, 0.82);
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Pro Display', 'Helvetica Neue', sans-serif;
    background:
      radial-gradient(circle at top, rgba(255, 255, 255, 0.86), rgba(255, 255, 255, 0) 42%),
      radial-gradient(circle at 18% 18%, rgba(230, 164, 226, 0.22), rgba(230, 164, 226, 0) 30%),
      radial-gradient(circle at 78% 22%, rgba(125, 168, 250, 0.22), rgba(125, 168, 250, 0) 28%),
      var(--page-bg);
    min-height: 100vh;
    padding: 40px 20px;
    color: var(--ink);
  }
  .container { max-width: 1200px; margin: 0 auto; }
  .header { text-align: center; margin-bottom: 40px; }
  .header-icons {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 20px;
    margin-bottom: 30px;
  }
  .header-icons img { height: 60px; width: auto; object-fit: contain; }
  .header-icons .separator { font-size: 32px; color: rgba(91, 79, 117, 0.48); font-weight: 300; }
  .header h1 { font-size: 42px; font-weight: 700; margin-bottom: 16px; line-height: 1.15; color: var(--ink); letter-spacing: -0.03em; }
  .header p { font-size: 16px; color: var(--muted); max-width: 700px; margin: 0 auto 20px; line-height: 1.6; }
  .card {
    background: var(--card-bg);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border-radius: 24px;
    padding: 40px 32px;
    box-shadow: var(--card-shadow);
    border: 1px solid var(--soft-line);
    max-width: 560px;
    margin: 0 auto;
  }
  .card p { font-size: 16px; color: #2d2647; line-height: 1.65; margin-bottom: 24px; }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0 auto 18px;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.66);
    border: 1px solid rgba(131, 102, 164, 0.14);
    color: #7b5f98;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .eyebrow::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: linear-gradient(135deg, #ffb7dd, #df5bb9);
    box-shadow: 0 0 0 4px rgba(223, 91, 185, 0.12);
  }
  .status-card {
    position: relative;
    overflow: hidden;
    max-width: 620px;
    padding: 48px 36px 34px;
  }
  .status-card::before {
    content: '';
    position: absolute;
    inset: 0 auto auto 0;
    width: 180px;
    height: 180px;
    background: radial-gradient(circle, rgba(223, 91, 185, 0.18), rgba(223, 91, 185, 0));
    pointer-events: none;
  }
  .status-icon {
    width: 72px;
    height: 72px;
    border-radius: 22px;
    display: grid;
    place-items: center;
    margin: 0 auto 22px;
    font-size: 34px;
    background: linear-gradient(145deg, rgba(255, 255, 255, 0.9), rgba(252, 236, 246, 0.82));
    border: 1px solid rgba(223, 91, 185, 0.18);
    box-shadow: 0 12px 30px rgba(193, 94, 162, 0.18);
  }
  .status-title {
    font-size: 34px;
    line-height: 1.12;
    letter-spacing: -0.03em;
    margin-bottom: 14px;
    text-align: center;
  }
  .status-copy {
    text-align: center;
    color: var(--muted);
    margin: 0 auto 28px;
    max-width: 480px;
  }
  .status-copy strong { color: var(--ink); }
  .tip-strip {
    display: grid;
    gap: 10px;
    margin: 0 0 26px;
    padding: 16px 18px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(131, 102, 164, 0.12);
  }
  .tip-strip span {
    font-size: 14px;
    color: #544b70;
  }
  .btn {
    display: inline-block;
    width: 100%;
    padding: 16px 32px;
    background: linear-gradient(135deg, var(--accent), #eb76c7);
    color: white;
    border: none;
    border-radius: 16px;
    font-size: 16px;
    font-weight: 600;
    text-decoration: none;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 12px 28px rgba(223, 91, 185, 0.26);
  }
  .btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 16px 32px rgba(223, 91, 185, 0.34);
    background: linear-gradient(135deg, var(--accent-deep), var(--accent));
    color: white;
  }
  .btn-secondary {
    display: inline-block;
    width: 100%;
    padding: 14px 22px;
    border-radius: 16px;
    text-align: center;
    text-decoration: none;
    font-size: 15px;
    font-weight: 600;
    color: #58467f;
    background: rgba(255, 255, 255, 0.74);
    border: 1px solid rgba(131, 102, 164, 0.14);
    margin-top: 12px;
  }
  .muted { color: var(--muted); font-size: 14px; text-align: center; }
  .stack { display: grid; gap: 12px; }
  @media (max-width: 640px) {
    body { padding: 28px 16px; }
    .header { margin-bottom: 28px; }
    .header-icons { gap: 14px; margin-bottom: 22px; }
    .header-icons img { height: 46px; }
    .header h1, .status-title { font-size: 30px; }
    .card, .status-card { padding: 30px 22px 24px; border-radius: 22px; }
  }
`;

const miniPageStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif; background: linear-gradient(160deg, hsl(310 25% 97%), hsl(270 30% 96.5%)); color: hsl(270 20% 15%); -webkit-font-smoothing: antialiased; }
  .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 360px; background: rgba(255,255,255,0.85); backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px); border: 1.5px solid rgba(255,255,255,0.5); border-radius: 24px; padding: 32px 24px; text-align: center; box-shadow: 0 8px 32px -8px rgba(120,80,140,0.12); }
  .icon { width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 24px; font-weight: 700; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
  p { font-size: 14px; color: hsl(270 10% 50%); line-height: 1.5; margin-bottom: 24px; }
  a.btn { display: inline-block; text-decoration: none; background: hsl(270 20% 15%); color: white; padding: 14px 32px; border-radius: 16px; font-size: 15px; font-weight: 600; transition: opacity 0.2s; }
  a.btn:active { opacity: 0.85; transform: scale(0.98); }
  .brand { margin-top: 20px; font-size: 12px; color: hsl(270 10% 70%); }
`;

const readTelegramReturnUrl = (): string => {
  const username = (process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");
  return username ? `https://t.me/${username}` : "tg://resolve";
};

const renderMiniPage = (opts: {
  title: string;
  pageTitle: string;
  icon: string;
  iconColor: string;
  iconBg: string;
  description: string;
  buttonLabel: string;
}): string => {
  const url = readTelegramReturnUrl();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${opts.pageTitle} — PIN Claw</title>
  <style>${miniPageStyles}</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="icon" style="background:${opts.iconBg};color:${opts.iconColor}">${opts.icon}</div>
      <h1>${opts.title}</h1>
      <p>${opts.description}</p>
      <a class="btn" href="${url}">${opts.buttonLabel}</a>
      <div class="brand">PIN Claw</div>
    </div>
  </div>
</body>
</html>`;
};

export const renderSuccessPage = (mode?: string): string => {
  const isDowngrade = mode === "downgrade_scheduled";
  return renderMiniPage({
    title: isDowngrade ? "Plan Change Scheduled" : "Subscription Activated",
    pageTitle: isDowngrade ? "Plan Changed" : "Subscription Active",
    icon: isDowngrade ? "↻" : "✓",
    iconColor: isDowngrade ? "#a855f7" : "#22c55e",
    iconBg: isDowngrade ? "rgba(168,85,247,0.1)" : "rgba(34,197,94,0.1)",
    description: isDowngrade
      ? "Your new plan will take effect at the next billing cycle. Current credits remain available until then."
      : "Payment complete! Your credits are active and your assistant will be ready shortly.",
    buttonLabel: "Back to Telegram",
  });
};

export const renderCancelPage = (): string => {
  return renderMiniPage({
    title: "Checkout Cancelled",
    pageTitle: "Cancelled",
    icon: "—",
    iconColor: "#a1a1aa",
    iconBg: "rgba(161,161,170,0.1)",
    description: "No charge was made. You can subscribe anytime from the Mini App in Telegram.",
    buttonLabel: "Back to Telegram",
  });
};

export const renderSubscribeUnavailablePage = (options?: {
  reason?: "expired" | "invalid" | "unavailable";
}): string => {
  const reason = options?.reason ?? "unavailable";
  const description =
    reason === "expired"
      ? "This link has expired for security reasons. Please return to Telegram and request a new one."
      : reason === "invalid"
        ? "This link is no longer valid. Please open a new one from Telegram."
        : "Something went wrong. Please go back to Telegram and try again.";
  return renderMiniPage({
    title: "Link Unavailable",
    pageTitle: "Unavailable",
    icon: "✕",
    iconColor: "#ef4444",
    iconBg: "rgba(239,68,68,0.1)",
    description,
    buttonLabel: "Back to Telegram",
  });
};

export const renderSubscribePage = (token: string): string => {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenClaw Cloud - Pricing</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.60) 0%, rgba(249, 237, 250, 0.26) 7.25%, rgba(247, 231, 249, 0.35) 11.8%, rgba(244, 222, 246, 0.49) 19.12%, rgba(242, 215, 244, 0.60) 32.22%, rgba(246, 206, 216, 0.60) 48.33%, rgba(180, 202, 244, 0.60) 80.24%, rgba(220, 211, 241, 0.60) 88.99%, rgba(223, 212, 240, 0.00) 100%), #FFF;
        min-height: 100vh;
        padding: 40px 20px;
        color: #1a1a1a;
      }
      .container { max-width: 1200px; margin: 0 auto; }
      .header { text-align: center; margin-bottom: 60px; }
      .header-icons {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 20px;
        margin-bottom: 30px;
      }
      .header-icons img {
        height: 60px;
        width: auto;
        object-fit: contain;
      }
      .header-icons .separator {
        font-size: 32px;
        color: #999;
        font-weight: 300;
      }
      .header h1 { font-size: 42px; font-weight: 700; margin-bottom: 16px; line-height: 1.2; color: #000; }
      .header p { font-size: 16px; color: #666; max-width: 700px; margin: 0 auto 20px; line-height: 1.6; }
      .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; margin-bottom: 40px; }
      .plan {
        background: white;
        border-radius: 16px;
        padding: 40px 32px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
        transition: all 0.3s ease;
        border: 2px solid transparent;
        position: relative;
        display: flex;
        flex-direction: column;
      }
      .plan:hover {
        transform: translateY(-4px);
        box-shadow: 0 8px 30px rgba(225, 92, 230, 0.15);
        border-color: #E15CE6;
      }
      .plan.popular::before {
        content: 'MOST POPULAR';
        position: absolute;
        top: -12px;
        left: 50%;
        transform: translateX(-50%);
        background: #E15CE6;
        color: white;
        padding: 4px 16px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .plan-name { font-size: 24px; font-weight: 600; margin-bottom: 12px; color: #000; }
      .plan-price { display: flex; align-items: baseline; margin-bottom: 8px; }
      .plan-price .currency { font-size: 32px; font-weight: 700; color: #000; }
      .plan-price .amount { font-size: 48px; font-weight: 700; color: #000; line-height: 1; }
      .plan-price .period { font-size: 18px; color: #666; margin-left: 4px; }
      .plan-description { font-size: 14px; color: #666; margin-bottom: 28px; }
      .features { list-style: none; margin-bottom: 32px; flex: 1; }
      .features li { padding: 10px 0; font-size: 15px; color: #333; position: relative; padding-left: 24px; }
      .features li::before { content: '•'; position: absolute; left: 8px; color: #E15CE6; font-size: 20px; line-height: 1; }
      .btn {
        width: 100%;
        padding: 16px 32px;
        background: #E15CE6;
        color: white;
        border: none;
        border-radius: 12px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 4px 12px rgba(225, 92, 230, 0.3);
      }
      .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(225, 92, 230, 0.4);
        background: #C94DD4;
      }
      .btn:active { transform: translateY(0); }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .err { color: #b91c1c; text-align: center; margin-bottom: 20px; font-weight: 500; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <div class="header-icons">
          <img src="/logo_pinai.png" alt="PIN AI Logo">
          <div class="separator">×</div>
          <img src="/logo_openclaw.png" alt="OpenClaw Logo">
        </div>
        <h1>One-Click Cloud Deployment<br>for OpenClaw</h1>
        <p>OpenClaw is powerful but difficult to set up.<br>PIN AI makes it simple — deploy OpenClaw's capabilities on the cloud instantly.</p>
        <p id="error" class="err"></p>
      </div>
      <div id="plans" class="plans"></div>
    </div>
    <script>
      const token = ${JSON.stringify(token)};
      const plansEl = document.getElementById('plans');
      const errorEl = document.getElementById('error');

      const setError = (text) => {
        errorEl.textContent = text || '';
      };

      async function createCheckout(planId) {
        setError('');
        const response = await fetch('/api/payment/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, plan: planId })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.url) {
          setError(payload.error || 'Failed to create checkout session');
          return;
        }
        window.location.href = payload.url;
      }

      async function loadPlans() {
        setError('');
        const response = await fetch('/api/payment/plans');
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(payload.plans)) {
          setError(payload.error || 'Failed to load plans');
          return;
        }

        plansEl.innerHTML = payload.plans
          .map((plan) => {
            const features = Array.isArray(plan.features)
              ? plan.features.map((f) => '<li>' + f + '</li>').join('')
              : '';
            const popularClass = plan.popular ? ' popular' : '';
            return (
              '<article class=\"plan' + popularClass + '\">' +
              '<div class=\"plan-name\">' + plan.name + '</div>' +
              '<div class=\"plan-price\">' +
              '<span class=\"currency\">$</span>' +
              '<span class=\"amount\">' + plan.price + '</span>' +
              '<span class=\"period\">/mo</span>' +
              '</div>' +
              '<div class=\"plan-description\">' + plan.description + '</div>' +
              '<ul class=\"features\">' + features + '</ul>' +
              '<button class=\"btn subscribe-btn\" data-plan=\"' + plan.id + '\">Subscribe</button>' +
              '</article>'
            );
          })
          .join('');

        document.querySelectorAll('button[data-plan]').forEach((button) => {
          button.addEventListener('click', () => {
            const plan = button.getAttribute('data-plan');
            if (plan) createCheckout(plan);
          });
        });
      }

      loadPlans();
    </script>
  </body>
</html>`;
};
