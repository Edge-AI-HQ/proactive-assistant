import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Cancelled - OpenClaw Cloud</title>
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
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 40px 20px;
            color: #1a1a1a;
          }

          .container {
            max-width: 600px;
            width: 100%;
          }

          .card {
            background: white;
            border-radius: 16px;
            padding: 60px 40px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
            text-align: center;
          }

          .header-icons {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 20px;
            margin-bottom: 40px;
          }

          .header-icons img {
            height: 50px;
            width: auto;
            object-fit: contain;
          }

          .header-icons .separator {
            font-size: 28px;
            color: #999;
            font-weight: 300;
          }

          h1 {
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 16px;
            color: #000;
          }

          p {
            font-size: 16px;
            color: #666;
            line-height: 1.6;
            margin-bottom: 40px;
          }

          .button {
            display: inline-block;
            width: 100%;
            max-width: 300px;
            padding: 16px 32px;
            background: #E15CE6;
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            text-decoration: none;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(225, 92, 230, 0.3);
          }

          .button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(225, 92, 230, 0.4);
            background: #C94DD4;
          }

          .footer {
            text-align: center;
            color: #999;
            font-size: 14px;
            margin-top: 30px;
          }

          @media (max-width: 768px) {
            .card {
              padding: 40px 24px;
            }

            h1 {
              font-size: 28px;
            }

            .header-icons img {
              height: 40px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <div class="header-icons">
              <img src="/logo_pinai.png" alt="PIN AI Logo">
              <div class="separator">×</div>
              <img src="/logo_openclaw.png" alt="OpenClaw Logo">
            </div>

            <h1>Payment Cancelled</h1>

            <p>
              You've cancelled the payment process.<br>
              No charges have been made to your account.<br><br>
              Feel free to come back anytime when you're ready!
            </p>

            <a href="https://t.me/${process.env.TELEGRAM_BOT_USERNAME || 'your_bot'}" class="button">
              Return to Telegram
            </a>
          </div>

          <div class="footer">
            Secure payment powered by Stripe
          </div>
        </div>

        <script>
          // Auto-close window after 5 seconds if opened as popup
          setTimeout(() => {
            if (window.opener) {
              window.close();
            }
          }, 5000);
        </script>
      </body>
    </html>
  `);
}
