export const renderSuccessPage = (): string => {
  const username = (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
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
  const username = (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
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
    <title>Choose Subscription Plan</title>
    <style>
      body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding: 24px; max-width: 960px; margin: 24px auto; }
      .plans { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 12px; margin-top: 20px; }
      .plan { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
      .btn { margin-top: 10px; border: 0; border-radius: 8px; padding: 10px 12px; background: #2f6feb; color:#fff; cursor:pointer; }
      .err { color: #b91c1c; }
    </style>
  </head>
  <body>
    <h1>Choose your plan</h1>
    <p>100 credits = $1 usage budget</p>
    <p id="error" class="err"></p>
    <div id="plans" class="plans"></div>
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
            return (
              '<article class=\"plan\"><h3>' +
              plan.name +
              '</h3><p>$' +
              plan.price +
              '/mo</p><ul>' +
              features +
              '</ul><button class=\"btn\" data-plan=\"' +
              plan.id +
              '\">Subscribe</button></article>'
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
