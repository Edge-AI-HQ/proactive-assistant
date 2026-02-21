# PIN AI Assistant Monorepo

Telegram-based assistant platform with container orchestration, per-assistant LiteLLM key management, and Stripe payment stack.

## Repository Layout

- `apps/pinclaw-bot` - Telegram onboarding bot + admin dashboard + control-plane app
- `infra/container-manager` - Container runtime package + OpenClaw image (`@pin-ai/infra-container-manager`)
- `infra/litellm` - LiteLLM package + config/docs (`@pin-ai/infra-litellm`)
- `infra/supabase` - Shared Supabase package + migrations (`@pin-ai/infra-supabase`)
- `infra/payment` - Unified Vercel payment service (landing + checkout + webhooks) (`@pin-ai/infra-payment`)

## Quick Start

1. Install dependencies (workspace root)
```bash
npm install
```

2. Configure environment
```bash
cp apps/pinclaw-bot/.env.example apps/pinclaw-bot/.env
```

Optional module-specific templates:
- `infra/litellm/.env.example`

Required for master app:
- `TELEGRAM_BOT_TOKEN`
- `SUPABASE_DB_URL`

3. Build OpenClaw image (once)
```bash
docker build -t pinai-openclaw:latest ./infra/container-manager/images/openclaw
```

4. Run master bot API
```bash
npm run dev
```

5. Type-check and build
```bash
npm run type-check
npm run build
```

## Payment Stack

Run unified payment service locally:
```bash
npm run dev:payment
```
Default URL: `http://localhost:3001`

Pinclaw-bot and payment service env:
- `PAYMENT_ENABLED=true` (pinclaw-bot)
- `PAYMENT_SERVICE_BASE_URL=<infra-payment-base-url>` (pinclaw-bot)
- `PAYMENT_SERVICE_API_KEY=<shared-secret>` (pinclaw-bot)
- `PAYMENT_SERVICE_API_KEY=<shared-secret>` (infra/payment)
- `PAYMENT_PUBLIC_BASE_URL=<infra-payment-public-https-url>` (infra/payment, optional but recommended if internal URL differs from public URL)

## LiteLLM (Supabase Postgres)

Set in `infra/litellm/.env`:
- `SUPABASE_DB_URL` (recommended: include `?sslmode=require`)
- `LITELLM_MASTER_KEY`
- `LITELLM_SALT_KEY` (required for LiteLLM container)
- provider keys (`ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`)

Set in `apps/pinclaw-bot/.env`:
- `LITELLM_ENABLED=true`
- `LITELLM_MASTER_KEY` (must match `infra/litellm/.env`)
- `LITELLM_KEY_ENCRYPTION_SECRET`
- `LITELLM_BASE_URL` / `LITELLM_CONTAINER_BASE_URL` as needed

Start / restart LiteLLM:
```bash
npm run litellm:restart
```

Clean up old local helper DB container (one-time if it exists):
```bash
npm run litellm:cleanup-local-db
```

Verify LiteLLM container is using Supabase URL:
```bash
npm run litellm:verify-db-env
```

## Master Bot Endpoints

- `POST /webhook/telegram`
- `GET /auth/telegram/gateway`
- `GET /auth/telegram/callback`
- `GET /admin`
- `GET /admin/dashboard`
- `GET /health`

## Database

Unified schema setup guide:
- `infra/supabase/SETUP.md`
- `infra/supabase/migrations/001_unified_schema.sql`

Schema management is migration-only (no runtime auto-create in app startup).
