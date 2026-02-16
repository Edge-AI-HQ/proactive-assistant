# PIN AI Assistant - Project Structure

This repository contains two related but independently deployable services for the PIN AI OpenClaw cloud platform.

## 📁 Project Layout

```
PIN-AI-ASSISTANT/
├── src/                          # Container Service (Express.js)
│   ├── server.ts                 # Main server entry
│   ├── docker/                   # Docker container management
│   ├── telegram/                 # Telegram bot implementation
│   ├── auth/                     # Telegram web login authentication
│   ├── admin/                    # Admin dashboard
│   └── db.ts                     # SQLite database
│
├── openclaw-cloud-payment/       # Payment Service (Vercel Serverless)
│   ├── api/                      # Vercel serverless functions
│   │   ├── subscribe.ts          # Pricing page
│   │   ├── create-checkout.ts    # Stripe checkout
│   │   ├── success.ts            # Payment success page
│   │   ├── cancel.ts             # Payment cancel page
│   │   └── webhook/
│   │       ├── stripe.ts         # Stripe webhook handler
│   │       └── telegram.ts       # Telegram bot webhook
│   ├── lib/                      # Shared utilities
│   ├── public/                   # Static assets (logos)
│   └── supabase/                 # Database migrations
│
└── openclaw-image/               # OpenClaw Docker image
    └── Dockerfile
```

---

## 🏗️ Architecture Overview

### Container Service (Main Application)
**Purpose:** Manage OpenClaw Docker containers for authenticated users

**Tech Stack:**
- Express.js (long-running server)
- SQLite database
- Dockerode (Docker API)
- Grammy (Telegram bot)

**Deployment:** VPS/Cloud server with Docker access

**Key Features:**
- One OpenClaw container per user
- Telegram ID based identity
- Telegram login required for Gateway UI web access
- Admin dashboard
- Container lifecycle management
- Port allocation (20000-22000)

### Payment Service (Public Gateway)
**Purpose:** Handle public subscriptions and payments

**Tech Stack:**
- Vercel Serverless Functions
- Supabase (PostgreSQL)
- Stripe payments
- Static HTML pages

**Deployment:** Vercel (serverless)

**Key Features:**
- Stripe subscription management (Basic/Pro/Max)
- Public pricing pages
- Payment webhooks
- One-time payment tokens

---

## 🚀 Deployment Guide

### Deploy Container Service

1. **Prerequisites**
   - Server with Docker installed
   - Node.js 20+
   - Domain with SSL

2. **Setup**
   ```bash
   # Install dependencies
   npm install

   # Build OpenClaw image
   docker build -t pinai-openclaw:latest ./openclaw-image

   # Configure environment
   cp .env.example .env
   # Edit .env with your credentials

   # Generate admin password
   npm run hash-password -- "your-password"

   # Start server
   npm run build
   npm start
   ```

3. **Set Telegram webhook**
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://your-domain.com/webhook/telegram" \
     -d "secret_token=<WEBHOOK_SECRET>"
   ```

### Deploy Payment Service

1. **Prerequisites**
   - Vercel account
   - Stripe account
   - Supabase project

2. **Setup**
   ```bash
   cd openclaw-cloud-payment

   # Install Vercel CLI
   npm install -g vercel

   # Deploy
   vercel --prod
   ```

3. **Configure environment variables in Vercel**
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_DOMAIN`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PUBLISHABLE_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_ID_BASIC`
   - `STRIPE_PRICE_ID_PRO`
   - `STRIPE_PRICE_ID_MAX`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_KEY`

4. **Set Stripe webhook**
   - URL: `https://your-vercel-app.vercel.app/api/webhook/stripe`
   - Events: `checkout.session.completed`, `customer.subscription.*`

---

## 🔗 Integration Points

### Payment → Container Service

When a payment succeeds, the Payment Service should call the Container Service API to provision a container:

```typescript
// In Payment Service webhook (api/webhook/stripe.ts)
await fetch('https://container-service.pinai.io/api/provision-container', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${CONTAINER_SERVICE_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    telegram_user_id: metadata.telegram_user_id,
    stripe_customer_id: customer,
    plan: metadata.plan  // basic/pro/max
  })
});
```

### Container Service API (To Be Added)

```typescript
// In Container Service (src/server.ts)
app.post('/api/provision-container', async (req, res) => {
  // Verify API key
  // Create/update user
  // Allocate port
  // Start container with appropriate resources based on plan
  // Return container info
});
```

---

## 📊 Database Schemas

### Container Service (SQLite)

```sql
users (
  id, telegram_user_id, telegram_username,
  container_id, container_port, container_status,
  gateway_token, created_at, last_active_at
)

gateway_sessions (
  id, telegram_user_id, session_token, expires_at
)

message_logs (
  id, telegram_user_id, direction, message_text, created_at
)

admin_users (
  id, username, password_hash, email, created_at
)
```

### Payment Service (Supabase/PostgreSQL)

```sql
payment_sessions (
  id, token, telegram_user_id, telegram_username,
  used, expires_at, created_at
)

user_subscriptions (
  id, telegram_user_id, stripe_customer_id,
  stripe_subscription_id, docker_instance_id,
  status, current_period_end, created_at
)

payment_events (
  id, telegram_user_id, stripe_event_id,
  event_type, amount, currency, status, raw_data
)
```

---

## 🔐 Security Notes

- Container Service uses Telegram login for Gateway web access
- Payment Service uses Stripe for public user payments
- Both services have separate authentication mechanisms
- API keys should be used for inter-service communication
- Never commit `.env` files or secrets to git

---

## 📝 Development Workflow

### Container Service
```bash
npm run dev          # Development with hot reload
npm run type-check   # TypeScript type checking
npm run lint         # ESLint
npm run build        # Compile TypeScript
npm start            # Run production build
```

### Payment Service
```bash
cd openclaw-cloud-payment
vercel dev           # Local development with Vercel CLI
vercel --prod        # Deploy to production
```

---

## 🐛 Troubleshooting

### Container Service
- Check Docker daemon is running: `docker ps`
- View container logs: `docker logs openclaw-user-<telegram_id>`
- Check port availability: `netstat -an | grep <port>`

### Payment Service
- Check Vercel logs: `vercel logs`
- Test Stripe webhook: Use Stripe CLI `stripe listen`
- Verify environment variables in Vercel dashboard

---

## 📚 Additional Documentation

- Container Service: See main `README.md`
- Payment Service: See `openclaw-cloud-payment/README.md`
- Deployment: See `DEPLOYMENT_SUMMARY.md` in payment module
