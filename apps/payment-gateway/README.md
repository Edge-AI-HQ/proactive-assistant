# Payment Gateway App

Landing pages + Telegram test bot layer.

## Scope

- Serves landing pages (`/api`, `/api/subscribe`, `/api/success`, `/api/cancel`)
- Hosts Telegram test webhook (`/api/webhook/telegram`)
- Proxies payment actions to `infra/payment`

This app no longer owns Stripe/Supabase business logic.

## Required Env

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
PAYMENT_BACKEND_BASE_URL=https://your-infra-payment.vercel.app
PAYMENT_BACKEND_API_KEY=
```

## Related Module

- Backend payment service: `/Users/boliangzhang/work/pin_ai/PIN-AI-ASSISTANT/infra/payment`
