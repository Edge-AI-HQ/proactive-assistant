# OpenClaw Cloud Payment Service

> **Note:** This module is part of the [PIN-AI-ASSISTANT](../) monorepo.

Public payment gateway for OpenClaw cloud subscriptions, deployed on Vercel as serverless functions.

## 🎯 Purpose

This service handles:
- Public subscription payments via Stripe
- Pricing page with three tiers (Basic/Pro/Max)
- Payment success/cancel pages
- Stripe webhook processing
- Integration with Telegram bot for payment links

## 🏗️ Architecture

- **Platform:** Vercel Serverless Functions
- **Database:** Supabase (PostgreSQL)
- **Payment:** Stripe Checkout + Subscriptions
- **Frontend:** Static HTML with modern design

## 🚀 Quick Start

### Prerequisites
- Vercel account
- Stripe account (test mode for development)
- Supabase project
- Telegram bot token

### Local Development

```bash
# Install Vercel CLI
npm install -g vercel

# Install dependencies
npm install

# Start local dev server
vercel dev
```

### Deployment

```bash
# Deploy to production
vercel --prod
```

## 🔧 Environment Variables

Configure these in Vercel dashboard or `.env` for local development:

```bash
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_WEBHOOK_DOMAIN=https://your-vercel-app.vercel.app
TELEGRAM_BOT_USERNAME=YourBotUsername

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_BASIC=price_...
STRIPE_PRICE_ID_PRO=price_...
STRIPE_PRICE_ID_MAX=price_...

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_KEY=eyJhbGc...
```

## 📋 API Endpoints

### Public Endpoints
- `GET /api/health` - Health check
- `GET /api/subscribe?token=xxx` - Pricing page (requires valid token)
- `GET /api/plans` - Get available plans
- `GET /api/success?session_id=xxx` - Payment success page
- `GET /api/cancel` - Payment cancelled page

### Internal Endpoints
- `POST /api/generate-payment-token` - Generate one-time payment token
- `POST /api/create-checkout` - Create Stripe checkout session
- `POST /api/webhook/telegram` - Telegram bot webhook
- `POST /api/webhook/stripe` - Stripe payment webhook

## 💳 Payment Flow

1. User sends `/start` to Telegram bot
2. Bot generates one-time payment token (valid 1 hour)
3. User opens payment link: `/api/subscribe?token=xxx`
4. User selects plan (Basic/Pro/Max)
5. Redirects to Stripe Checkout
6. On success → `/api/success`
7. On cancel → Returns to pricing page
8. Stripe webhook notifies backend
9. Backend provisions Docker container (via Container Service API)

## 🗄️ Database Schema

### payment_sessions
One-time tokens for secure payment links
```sql
CREATE TABLE payment_sessions (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL,
  telegram_username TEXT,
  used BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### user_subscriptions
Stripe subscription records
```sql
CREATE TABLE user_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  docker_instance_id TEXT,
  status TEXT DEFAULT 'active',
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### payment_events
Payment event logs
```sql
CREATE TABLE payment_events (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT,
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  amount INT,
  currency TEXT,
  status TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 🎨 Design

- Modern gradient background
- PIN AI × OpenClaw dual branding
- Brand color: `#E15CE6`
- Responsive design
- Clean, minimal UI

## 🔗 Integration with Container Service

When payment succeeds, this service should call the Container Service API:

```typescript
// In api/webhook/stripe.ts
await fetch('https://container-service.pinai.io/api/provision-container', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${CONTAINER_SERVICE_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    telegram_user_id: metadata.telegram_user_id,
    stripe_customer_id: customer,
    plan: metadata.plan
  })
});
```

## 📝 Development Notes

- Token-based security prevents unauthorized access to pricing page
- Tokens expire after 1 hour
- Tokens are single-use (marked as used after checkout)
- Cancel payment returns user to pricing page with same token
- All sensitive operations use Supabase service role key

## 🐛 Troubleshooting

### Vercel Deployment Issues
```bash
# Check logs
vercel logs

# Inspect specific deployment
vercel inspect <deployment-url>
```

### Stripe Webhook Issues
```bash
# Test locally with Stripe CLI
stripe listen --forward-to localhost:3000/api/webhook/stripe

# Trigger test events
stripe trigger checkout.session.completed
```

### Database Issues
- Check Supabase logs in dashboard
- Verify RLS policies are correct
- Ensure service role key has proper permissions

## 📚 Additional Documentation

- [Project Structure](../PROJECT_STRUCTURE.md) - Overall architecture
- [Deployment Summary](./DEPLOYMENT_SUMMARY.md) - Deployment details
- [Quick Start Guide](./QUICKSTART.md) - Setup instructions

## 🔐 Security

- Payment tokens are cryptographically random (64 bytes)
- All database operations use Row Level Security (RLS)
- Stripe webhook signatures are verified
- No sensitive data in client-side code
- Environment variables never exposed to frontend

---

**Part of PIN AI Assistant Platform** | [Main Repository](../)
