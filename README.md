# PIN AI Assistant Monorepo

Telegram-based assistant platform with container orchestration, per-assistant LiteLLM key management, and Stripe payment stack.

## Repository Layout

- `apps/pinclaw-bot` - Telegram onboarding bot + admin dashboard + control-plane app
- `apps/payment-gateway` - Vercel landing pages + payment test bot app (calls infra payment API)
- `infra/container-manager` - Container runtime package + OpenClaw image (`@pin-ai/infra-container-manager`)
- `infra/litellm` - LiteLLM package + config/docs (`@pin-ai/infra-litellm`)
- `infra/supabase` - Shared Supabase package + migrations (`@pin-ai/infra-supabase`)
- `infra/payment` - Vercel payment backend API (`@pin-ai/infra-payment`)

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
- `apps/payment-gateway/.env.example`
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

Run landing app locally:
```bash
npm run dev:payment
```

Run payment backend locally:
```bash
npm run dev:payment-backend
```

Pinclaw/payment-gateway to payment-backend env:
- `PAYMENT_GATEWAY_ENABLED=true` (pinclaw-bot)
- `PAYMENT_GATEWAY_BASE_URL=<infra-payment-base-url>` (pinclaw-bot)
- `PAYMENT_GATEWAY_INTERNAL_API_KEY=<shared-secret>` (pinclaw-bot)
- `PAYMENT_BACKEND_BASE_URL=<infra-payment-base-url>` (payment-gateway app)
- `PAYMENT_BACKEND_API_KEY=<shared-secret>` (payment-gateway app)
- `PAYMENT_SERVICE_API_KEY=<shared-secret>` (infra/payment)
- `PAYMENT_LANDING_BASE_URL=<apps-payment-gateway-base-url>` (infra/payment)

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
