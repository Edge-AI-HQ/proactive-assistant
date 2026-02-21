# Infra Payment Service

Unified payment service deployed on Vercel.

## Responsibility

- Stripe checkout/session orchestration + landing pages
- Stripe webhook processing
- Subscription state APIs for app services
- Payment session token issuance for pinclaw-bot

## Endpoints

- `GET /` (landing static page)
- `GET /api/health`
- `GET /api/plans`
- `GET /api/subscribe?token=...`
- `GET /api/success`
- `GET /api/cancel`
- `POST /api/create-checkout`
- `POST /api/internal/payment-session` (requires `x-api-key`)
- `GET /api/internal/subscription` (requires `x-api-key`)
- `GET /api/internal/payment-session-validate` (requires `x-api-key`)
- `POST|GET /api/internal/credits-maintenance` (requires `x-api-key` or cron bearer token)
- `POST /api/webhook/stripe`

## Local

```bash
npm run dev:vercel --workspace @pin-ai/infra-payment
```

Default URL: `http://localhost:3001`
