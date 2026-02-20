# Infra Payment Service

Payment backend service deployed on Vercel.

## Responsibility

- Stripe checkout/session orchestration
- Stripe webhook processing
- Subscription state APIs for app services
- Payment session token issuance for pinclaw-bot and payment-gateway app

## Endpoints

- `GET /api/health`
- `GET /api/plans`
- `POST /api/create-checkout`
- `POST /api/internal/payment-session` (requires `x-api-key`)
- `GET /api/internal/subscription` (requires `x-api-key`)
- `GET /api/internal/payment-session-validate` (requires `x-api-key`)
- `POST /api/webhook/stripe`

## Local

```bash
npm run dev --workspace @pin-ai/infra-payment
```
