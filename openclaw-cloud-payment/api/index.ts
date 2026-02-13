import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'YOUR_BOT_USERNAME';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PIN AI × OpenClaw Cloud - One-Click Deployment</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #E15CE6;
      --primary-dark: #C94DD4;
      --text-dark: #1a1a1a;
      --text-medium: #666;
      --text-light: #999;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.60) 0%, rgba(249, 237, 250, 0.26) 7.25%, rgba(247, 231, 249, 0.35) 11.8%, rgba(244, 222, 246, 0.49) 19.12%, rgba(242, 215, 244, 0.60) 32.22%, rgba(246, 206, 216, 0.60) 48.33%, rgba(180, 202, 244, 0.60) 80.24%, rgba(220, 211, 241, 0.60) 88.99%, rgba(223, 212, 240, 0.00) 100%), #FFF;
      min-height: 100vh;
      color: var(--text-dark);
      overflow-x: hidden;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 60px 24px;
    }

    /* Hero Section */
    .hero {
      text-align: center;
      margin-bottom: 80px;
      animation: fadeInUp 0.8s ease-out;
    }

    .logo-section {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 24px;
      margin-bottom: 48px;
      animation: fadeInUp 0.8s ease-out 0.2s backwards;
    }

    .logo-section img {
      height: 72px;
      width: auto;
      object-fit: contain;
      filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.08));
    }

    .logo-separator {
      font-size: 40px;
      color: var(--text-light);
      font-weight: 300;
    }

    .hero h1 {
      font-family: 'DM Serif Display', serif;
      font-size: clamp(36px, 5vw, 56px);
      font-weight: 400;
      line-height: 1.2;
      margin-bottom: 24px;
      color: var(--text-dark);
      animation: fadeInUp 0.8s ease-out 0.4s backwards;
    }

    .hero .subtitle {
      font-size: clamp(18px, 2.5vw, 22px);
      color: var(--text-medium);
      line-height: 1.6;
      max-width: 700px;
      margin: 0 auto 48px;
      font-weight: 300;
      animation: fadeInUp 0.8s ease-out 0.6s backwards;
    }

    /* CTA Button */
    .cta-button {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 20px 40px;
      background: var(--primary);
      color: white;
      text-decoration: none;
      border-radius: 16px;
      font-size: 20px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(225, 92, 230, 0.3);
      transition: all 0.3s ease;
      animation: fadeInUp 0.8s ease-out 0.8s backwards;
    }

    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 32px rgba(225, 92, 230, 0.4);
      background: var(--primary-dark);
    }

    .cta-button:active {
      transform: translateY(0);
    }

    .telegram-icon {
      font-size: 28px;
    }

    /* How It Works Section */
    .how-it-works {
      margin-bottom: 80px;
    }

    .section-title {
      font-family: 'DM Serif Display', serif;
      font-size: clamp(32px, 4vw, 42px);
      text-align: center;
      margin-bottom: 60px;
      color: var(--text-dark);
      animation: fadeInUp 0.8s ease-out 1s backwards;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 32px;
      margin-bottom: 48px;
    }

    .step {
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 32px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
      transition: all 0.3s ease;
      animation: fadeInUp 0.8s ease-out calc(1.2s + var(--delay)) backwards;
    }

    .step:nth-child(1) { --delay: 0s; }
    .step:nth-child(2) { --delay: 0.1s; }
    .step:nth-child(3) { --delay: 0.2s; }

    .step:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 30px rgba(225, 92, 230, 0.15);
    }

    .step-number {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--primary), var(--primary-dark));
      color: white;
      border-radius: 12px;
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 20px;
    }

    .step h3 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--text-dark);
    }

    .step p {
      font-size: 16px;
      line-height: 1.6;
      color: var(--text-medium);
      font-weight: 300;
    }

    /* Features Section */
    .features {
      background: rgba(255, 255, 255, 0.5);
      backdrop-filter: blur(10px);
      border-radius: 24px;
      padding: 48px;
      margin-bottom: 60px;
      animation: fadeInUp 0.8s ease-out 1.5s backwards;
    }

    .features h2 {
      font-family: 'DM Serif Display', serif;
      font-size: 32px;
      text-align: center;
      margin-bottom: 40px;
      color: var(--text-dark);
    }

    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 24px;
    }

    .feature-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .feature-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .feature-text {
      font-size: 16px;
      line-height: 1.5;
      color: var(--text-medium);
    }

    /* Footer */
    .footer {
      text-align: center;
      padding: 40px 0;
      color: var(--text-light);
      font-size: 14px;
      animation: fadeInUp 0.8s ease-out 1.7s backwards;
    }

    .footer a {
      color: var(--primary);
      text-decoration: none;
      transition: color 0.2s;
    }

    .footer a:hover {
      color: var(--primary-dark);
    }

    /* Animations */
    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Responsive */
    @media (max-width: 768px) {
      .container {
        padding: 40px 20px;
      }

      .logo-section {
        gap: 16px;
        margin-bottom: 32px;
      }

      .logo-section img {
        height: 56px;
      }

      .logo-separator {
        font-size: 32px;
      }

      .hero {
        margin-bottom: 60px;
      }

      .cta-button {
        padding: 16px 32px;
        font-size: 18px;
      }

      .steps {
        grid-template-columns: 1fr;
        gap: 24px;
      }

      .features {
        padding: 32px 24px;
      }

      .feature-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Decorative Elements */
    .bg-decoration {
      position: fixed;
      width: 400px;
      height: 400px;
      border-radius: 50%;
      filter: blur(80px);
      opacity: 0.3;
      pointer-events: none;
      z-index: -1;
    }

    .bg-decoration-1 {
      top: -100px;
      right: -100px;
      background: radial-gradient(circle, rgba(225, 92, 230, 0.4), transparent);
    }

    .bg-decoration-2 {
      bottom: -100px;
      left: -100px;
      background: radial-gradient(circle, rgba(180, 202, 244, 0.4), transparent);
    }
  </style>
</head>
<body>
  <!-- Decorative Background Elements -->
  <div class="bg-decoration bg-decoration-1"></div>
  <div class="bg-decoration bg-decoration-2"></div>

  <div class="container">
    <!-- Hero Section -->
    <section class="hero">
      <div class="logo-section">
        <img src="/logo_pinai.png" alt="PIN AI Logo">
        <span class="logo-separator">×</span>
        <img src="/logo_openclaw.png" alt="OpenClaw Logo">
      </div>

      <h1>Deploy OpenClaw to the Cloud<br>in One Click</h1>

      <p class="subtitle">
        OpenClaw is powerful but complex to set up. PIN AI makes it effortless —
        get your own cloud-hosted OpenClaw instance running in minutes,
        no command line required.
      </p>

      <a href="https://t.me/${botUsername}" class="cta-button" target="_blank" rel="noopener">
        <span class="telegram-icon">✈️</span>
        Start on Telegram
      </a>
    </section>

    <!-- How It Works -->
    <section class="how-it-works">
      <h2 class="section-title">How It Works</h2>

      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <h3>Open Telegram</h3>
          <p>Find our bot on Telegram and send <strong>/start</strong> to begin your journey.</p>
        </div>

        <div class="step">
          <div class="step-number">2</div>
          <h3>Choose Your Plan</h3>
          <p>Select from Basic, Pro, or Max plans based on your needs. All plans include dedicated resources.</p>
        </div>

        <div class="step">
          <div class="step-number">3</div>
          <h3>Start Building</h3>
          <p>Your OpenClaw instance will be ready in minutes. Start developing immediately with full cloud access.</p>
        </div>
      </div>
    </section>

    <!-- Features -->
    <section class="features">
      <h2>What You Get</h2>

      <div class="feature-grid">
        <div class="feature-item">
          <span class="feature-icon">⚡</span>
          <span class="feature-text">Instant deployment — no setup required</span>
        </div>

        <div class="feature-item">
          <span class="feature-icon">🔒</span>
          <span class="feature-text">Dedicated container with isolated resources</span>
        </div>

        <div class="feature-item">
          <span class="feature-icon">☁️</span>
          <span class="feature-text">24/7 uptime with automatic backups</span>
        </div>

        <div class="feature-item">
          <span class="feature-icon">📊</span>
          <span class="feature-text">Performance monitoring and analytics</span>
        </div>

        <div class="feature-item">
          <span class="feature-icon">💳</span>
          <span class="feature-text">Simple monthly billing, cancel anytime</span>
        </div>

        <div class="feature-item">
          <span class="feature-icon">🛠️</span>
          <span class="feature-text">Priority support from our team</span>
        </div>
      </div>
    </section>

    <!-- Footer -->
    <footer class="footer">
      <p>Powered by <a href="https://stripe.com" target="_blank">Stripe</a> • Hosted on <a href="https://vercel.com" target="_blank">Vercel</a></p>
      <p style="margin-top: 8px; opacity: 0.7;">© 2024 PIN AI. All rights reserved.</p>
    </footer>
  </div>

  <script>
    // Add smooth scroll behavior
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // Add intersection observer for scroll animations
    const observerOptions = {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
        }
      });
    }, observerOptions);

    // Observe all animated elements
    document.querySelectorAll('.step, .feature-item').forEach(el => {
      observer.observe(el);
    });
  </script>
</body>
</html>
  `);
}
