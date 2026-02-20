import { VercelRequest, VercelResponse } from '@vercel/node';
import { paymentBackendClient } from '../lib/paymentBackendClient.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = req.query.token as string;

  if (!token) {
    return res.status(400).send('Invalid or missing token');
  }

  try {
    await paymentBackendClient.validatePaymentSession(token);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.toLowerCase().includes('invalid token')) {
      return res.status(404).send('Invalid token');
    }
    if (message.toLowerCase().includes('already used')) {
      return res.status(400).send('Token already used');
    }
    if (message.toLowerCase().includes('expired')) {
      return res.status(400).send('Token expired');
    }
    return res.status(502).send(`Payment backend unavailable: ${message}`);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>OpenClaw Cloud - Pricing</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.60) 0%, rgba(249, 237, 250, 0.26) 7.25%, rgba(247, 231, 249, 0.35) 11.8%, rgba(244, 222, 246, 0.49) 19.12%, rgba(242, 215, 244, 0.60) 32.22%, rgba(246, 206, 216, 0.60) 48.33%, rgba(180, 202, 244, 0.60) 80.24%, rgba(220, 211, 241, 0.60) 88.99%, rgba(223, 212, 240, 0.00) 100%), #FFF;
            min-height: 100vh;
            padding: 40px 20px;
            color: #1a1a1a;
          }

          .container {
            max-width: 1200px;
            margin: 0 auto;
          }

          /* Header Section */
          .header {
            text-align: center;
            margin-bottom: 60px;
          }

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

          .header h1 {
            font-size: 42px;
            font-weight: 700;
            margin-bottom: 16px;
            line-height: 1.2;
            color: #000;
          }

          .header p {
            font-size: 16px;
            color: #666;
            max-width: 700px;
            margin: 0 auto;
            line-height: 1.6;
          }

          /* Pricing Cards */
          .plans {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            margin-bottom: 40px;
          }

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

          .plan-name {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 12px;
            color: #000;
          }

          .plan-price {
            display: flex;
            align-items: baseline;
            margin-bottom: 8px;
          }

          .plan-price .currency {
            font-size: 32px;
            font-weight: 700;
            color: #000;
          }

          .plan-price .amount {
            font-size: 48px;
            font-weight: 700;
            color: #000;
            line-height: 1;
          }

          .plan-price .period {
            font-size: 18px;
            color: #666;
            margin-left: 4px;
          }

          .plan-description {
            font-size: 14px;
            color: #666;
            margin-bottom: 28px;
          }

          .features {
            list-style: none;
            margin-bottom: 32px;
            flex: 1;
          }

          .features li {
            padding: 10px 0;
            font-size: 15px;
            color: #333;
            position: relative;
            padding-left: 24px;
          }

          .features li::before {
            content: '•';
            position: absolute;
            left: 8px;
            color: #E15CE6;
            font-size: 20px;
            line-height: 1;
          }

          .subscribe-btn {
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

          .subscribe-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(225, 92, 230, 0.4);
            background: #C94DD4;
          }

          .subscribe-btn:active {
            transform: translateY(0);
          }

          .subscribe-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          /* Loading State */
          .loading {
            display: none;
            text-align: center;
            padding: 60px 20px;
            color: #666;
          }

          .loading.active {
            display: block;
          }

          .loading-spinner {
            width: 40px;
            height: 40px;
            border: 4px solid #f3f3f3;
            border-top: 4px solid #e91e63;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
          }

          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }

          .footer {
            text-align: center;
            color: #999;
            font-size: 14px;
            margin-top: 40px;
          }

          /* Responsive */
          @media (max-width: 768px) {
            .header h1 {
              font-size: 32px;
            }

            .plans {
              grid-template-columns: 1fr;
              gap: 24px;
            }

            .plan {
              padding: 32px 24px;
            }
          }

          /* Error State */
          .error-message {
            background: #fee;
            border: 1px solid #fcc;
            color: #c33;
            padding: 16px;
            border-radius: 8px;
            text-align: center;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- Header -->
          <div class="header">
            <div class="header-icons">
              <img src="/logo_pinai.png" alt="PIN AI Logo">
              <div class="separator">×</div>
              <img src="/logo_openclaw.png" alt="OpenClaw Logo">
            </div>
            <h1>One-Click Cloud Deployment<br>for OpenClaw</h1>
            <p>OpenClaw is powerful but difficult to set up.<br>PIN AI makes it simple — deploy OpenClaw's capabilities on the cloud instantly —<br>no command line, no hassle, just one click.</p>
          </div>

          <!-- Pricing Grid -->
          <div class="plans" id="plans">
            <div class="loading active">
              <div class="loading-spinner"></div>
              <p>Loading pricing plans...</p>
            </div>
          </div>

          <div class="footer">
            Secure payment powered by Stripe
          </div>
        </div>

        <script>
          const token = '${token}';

          // 加载套餐信息
          async function loadPlans() {
            try {
              const response = await fetch('/api/plans');
              const data = await response.json();

              const plansContainer = document.getElementById('plans');
              plansContainer.innerHTML = '';

              data.plans.forEach(plan => {
                const planDiv = document.createElement('div');
                planDiv.className = 'plan' + (plan.popular ? ' popular' : '');

                const featuresHTML = plan.features.map(f => \`<li>\${f}</li>\`).join('');

                planDiv.innerHTML = \`
                  <div class="plan-name">\${plan.name}</div>
                  <div class="plan-price">
                    <span class="currency">$</span>
                    <span class="amount">\${plan.price}</span>
                    <span class="period">/mo</span>
                  </div>
                  <div class="plan-description">\${plan.description}</div>
                  <ul class="features">
                    \${featuresHTML}
                  </ul>
                  <button class="subscribe-btn" onclick="subscribe('\${plan.id}')">
                    Get Started
                  </button>
                \`;

                plansContainer.appendChild(planDiv);
              });
            } catch (error) {
              console.error('Failed to load plans:', error);
              document.getElementById('plans').innerHTML = '<div class="error-message">Failed to load plans. Please refresh the page.</div>';
            }
          }

          async function subscribe(plan) {
            try {
              const response = await fetch('/api/create-checkout', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  token: token,
                  plan: plan
                }),
              });

              const data = await response.json();

              if (data.url) {
                window.location.href = data.url;
              } else {
                throw new Error(data.error || 'Failed to create checkout session');
              }
            } catch (error) {
              console.error('Error:', error);
              alert('Payment session failed. Please try again.');
            }
          }

          // 页面加载时获取套餐
          loadPlans();
        </script>
      </body>
    </html>
  `);
}
