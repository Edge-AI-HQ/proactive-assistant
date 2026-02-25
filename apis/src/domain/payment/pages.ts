export const renderSuccessPage = (): string => {
  const username = (process.env.TELEGRAM_BOT_USERNAME || "")
    .trim()
    .replace(/^@/, "");
  const button = username
    ? `<a class="button" href="https://t.me/${username}" target="_blank" rel="noopener">Return to Telegram</a>`
    : `<p class="muted">Return to Telegram and continue with your bot.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subscription Active</title>
    <style>
      body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding: 24px; max-width: 680px; margin: 40px auto; }
      .card { border: 1px solid #d0e6da; border-radius: 12px; padding: 24px; }
      .button { display:inline-block; margin-top:12px; text-decoration:none; background:#2f6feb; color:#fff; padding:10px 16px; border-radius:8px; }
      .muted { color:#6b7280; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Subscription Activated</h1>
      <p>Your payment was completed successfully and credits are now managed by your active plan.</p>
      ${button}
    </div>
  </body>
</html>`;
};

export const renderCancelPage = (): string => {
  const username = (process.env.TELEGRAM_BOT_USERNAME || "")
    .trim()
    .replace(/^@/, "");
  const button = username
    ? `<a class="button" href="https://t.me/${username}" target="_blank" rel="noopener">Back to Telegram</a>`
    : `<p class="muted">No charge was made. Retry from Telegram anytime.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Payment Cancelled</title>
    <style>
      body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding: 24px; max-width: 680px; margin: 40px auto; }
      .card { border: 1px solid #f2d2cc; border-radius: 12px; padding: 24px; }
      .button { display:inline-block; margin-top:12px; text-decoration:none; background:#2f6feb; color:#fff; padding:10px 16px; border-radius:8px; }
      .muted { color:#6b7280; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Checkout Cancelled</h1>
      <p>No charge was made to your account.</p>
      ${button}
    </div>
  </body>
</html>`;
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
