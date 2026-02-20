# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw Cloud Payment Service - A Vercel serverless payment gateway for OpenClaw cloud subscriptions. Part of the PIN-AI-ASSISTANT monorepo.

## Essential Commands

```bash
# Local development
npm install
vercel dev                    # Start local dev server on http://localhost:3000

# Deployment
./deploy.sh                   # Full deployment with checks
vercel --prod                 # Direct production deployment

# Testing
vercel logs --follow          # View real-time logs
vercel logs --limit 100       # View recent logs

# Stripe testing
stripe listen --forward-to localhost:3000/api/webhook/stripe
stripe trigger checkout.session.completed
```

## Architecture

### Serverless Structure
- **Platform**: Vercel Serverless Functions (Node.js + TypeScript)
- **API Routes**: `/api/*` - Each file is a serverless endpoint
- **Shared Logic**: `/lib/*` - Reusable services (Stripe, DB, Docker, Bot)
- **Database**: Supabase PostgreSQL via `pg` connection pool
- **Payment**: Stripe Checkout with subscription webhooks

### Token-Based Payment Flow

Critical security pattern: Payment pages require one-time tokens to prevent unauthorized access.

1. User sends `/start` to Telegram bot
2. Bot calls `generatePaymentToken()` → creates token in `payment_sessions` table
3. Token is valid for 1 hour, single-use
4. User opens `/api/subscribe?token=xxx` → validates token
5. User selects plan → `/api/create-checkout` validates token again
6. Stripe checkout created (token NOT marked as used yet)
7. On payment success → Stripe webhook marks token as used
8. If user cancels → returns to pricing page with same token (can retry)

**Key insight**: Token is only marked `used=true` after successful payment (in webhook), not when checkout is created. This allows retry on payment failure.

### Webhook Processing

Two webhook handlers process async events:

**`/api/webhook/stripe.ts`**:
- Verifies Stripe signature with `STRIPE_WEBHOOK_SECRET`
- Handles `checkout.session.completed` → saves subscription, marks token used, sends Telegram notification
- Handles `customer.subscription.created` → activates subscription, updates period dates
- Logs all events to `payment_events` table

**`/api/webhook/telegram.ts`**:
- Handles bot commands (`/start`, `/help`)
- Generates payment tokens on `/start`
- Returns inline keyboard with payment URL

### Database Schema

**`payment_sessions`**: One-time payment tokens
- `token` (unique, indexed) - 64-char hex string
- `telegram_user_id` - User identifier
- `used` (boolean) - Marked true after successful payment
- `expires_at` - 1 hour from creation

**`user_subscriptions`**: Subscription records
- `telegram_user_id` (unique) - Primary user identifier
- `stripe_customer_id`, `stripe_subscription_id` - Stripe references
- `docker_container_id`, `docker_port`, `docker_url` - Container info (optional)
- `status` - 'active' | 'paused' | 'canceled' | 'pending'
- `current_period_start`, `current_period_end` - Billing period

**`payment_events`**: Audit log of all Stripe events
- `stripe_event_id` (unique) - Prevents duplicate processing
- `event_type`, `raw_data` - Full event details

## Multi-Plan Configuration

Three subscription tiers configured via environment variables:
- `STRIPE_PRICE_ID_BASIC` - Basic plan (2GB RAM)
- `STRIPE_PRICE_ID_PRO` - Pro plan (4GB RAM) - marked as "popular"
- `STRIPE_PRICE_ID_MAX` - Max plan (8GB RAM)

Plans are fetched dynamically from Stripe API in `/api/plans.ts` to display current pricing.

## Key Integration Points

### Stripe
- API version: `2023-10-16`
- Customer creation: Checks database first, reuses existing customer ID
- Metadata: Always include `telegram_user_id` and `telegram_username` in checkout sessions and subscriptions
- Webhook signature verification is mandatory (security)

### Supabase
- All DB access goes through `pg` pool in `lib/db.ts`
- Use a single connection string env var: `SUPABASE_DB_URL`
- Use parameterized SQL queries (`$1`, `$2`, ...) for all inputs
- Upsert pattern: `INSERT ... ON CONFLICT (telegram_user_id) DO UPDATE`

### Telegram Bot
- Bot sends payment links via inline keyboard buttons
- Notifications sent directly via Telegram API (not through Telegraf in webhooks)
- Format: `https://api.telegram.org/bot${TOKEN}/sendMessage`

## Environment Variables

Required for all deployments:
```bash
TELEGRAM_BOT_TOKEN              # Bot authentication
TELEGRAM_WEBHOOK_DOMAIN         # Your Vercel domain (for URLs)
STRIPE_SECRET_KEY               # Stripe API key
STRIPE_WEBHOOK_SECRET           # Webhook signature verification
STRIPE_PRICE_ID_BASIC           # Basic plan price ID
STRIPE_PRICE_ID_PRO             # Pro plan price ID
STRIPE_PRICE_ID_MAX             # Max plan price ID
SUPABASE_DB_URL                 # Supabase Postgres connection string
```

Set in Vercel dashboard or via `vercel env add`.

## Common Patterns

### Creating Stripe Customers
Always check database first to avoid duplicate customers:
```typescript
const existingSub = await db.getSubscriptionByTelegramId(user_id);

if (existingSub?.stripe_customer_id) {
  // Verify customer exists in Stripe (handles account switches)
  try {
    await stripe.customers.retrieve(existingSub.stripe_customer_id);
    customerId = existingSub.stripe_customer_id;
  } catch {
    // Customer not found, create new one
  }
}
```

### Webhook Body Parsing
Stripe webhooks require raw body for signature verification:
```typescript
export const config = {
  api: { bodyParser: false }
};

async function buffer(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
```

### Token Validation
Standard pattern for all token-protected endpoints:
```typescript
const session = await db.getPaymentSessionByToken(token);

if (!session || session.used || new Date(session.expires_at) < new Date()) {
  return res.status(400).json({ error: 'Invalid or expired token' });
}
```

## Testing Workflow

1. **Local development**: `vercel dev` (requires `.env` file)
2. **Test Stripe webhooks locally**: Use Stripe CLI to forward events
3. **Test cards**: `4242 4242 4242 4242` (any future date, any CVC)
4. **Check logs**: `vercel logs --follow` after deployment
5. **Verify database**: Check Supabase dashboard → Table Editor

## Deployment Notes

- Vercel automatically detects TypeScript and builds on deployment
- No build step needed (serverless functions compiled on-demand)
- Environment variables must be set in Vercel dashboard before deployment
- After deployment, update webhook URLs in Stripe and Telegram
- Database migrations must be run manually in Supabase SQL Editor

## Security Considerations

- Payment tokens are cryptographically random (32 bytes = 64 hex chars)
- Tokens expire after 1 hour and are single-use
- Stripe webhook signatures are always verified
- Database credentials are server-only (`SUPABASE_DB_URL`)
- No sensitive data in client-side code or metadata
- Customer IDs are validated before reuse (handles Stripe account switches)
