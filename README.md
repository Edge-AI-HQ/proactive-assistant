# PIN AI Assistant

Telegram-based AI assistant platform with integrated payment system.

## 📦 Project Components

This repository contains two services:

1. **Container Service** (main directory) - Internal team tool for managing OpenClaw containers
2. **Payment Service** (`openclaw-cloud-payment/`) - Public payment gateway for OpenClaw subscriptions

See [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) for detailed architecture documentation.
LiteLLM key/billing module design: [LITELLM_MODULE_DESIGN.md](./LITELLM_MODULE_DESIGN.md).

---

## Container Service

Telegram-based AI assistant backend for pinai.io team members.

Current runtime model:
- One shared Telegram bot (name is user-defined, e.g. `@YourTeamAssistantBot`)
- One OpenClaw Docker container per Telegram user
- Backend talks to each container via OpenClaw Gateway WS RPC (`chat.send`, `chat`, `agent` events)
- Telegram supports text, image input, voice input (transcription), and media/file output

## Quick Start

1. Install dependencies
```bash
npm install
```

2. Build OpenClaw image (once)
```bash
docker build -t pinai-openclaw:latest ./openclaw-image
```

3. Configure environment
```bash
cp .env.example .env
```

4. Generate admin password hash
```bash
npm run hash-password -- "your-password"
```
Copy the output into `ADMIN_PASSWORD_HASH`.

5. Start server
```bash
npm run dev
```

6. Type check and build
```bash
npm run type-check
npm run build
```

7. Run compiled server (production-like local run)
```bash
npm start
```

## LiteLLM Server Quick Start

If you want this repository to host LiteLLM locally:

1. Set LiteLLM vars in `.env`:
```bash
LITELLM_ENABLED=true
LITELLM_MASTER_KEY=<strong-random-secret>
LITELLM_SALT_KEY=<strong-random-secret>
LITELLM_KEY_ENCRYPTION_SECRET=<strong-random-secret>
```

2. Start LiteLLM + Postgres:
```bash
docker compose --profile litellm up -d litellm-db litellm
```

3. Detailed server setup:
- See `litellm/README.md`
- See `litellm/litellm_config.yaml`

## TypeScript Workflow

- `npm run dev` - run with `tsx` from source (`src/server.ts`)
- `npm run type-check` - strict type check without emit
- `npm run build` - compile TypeScript to `dist/`
- `npm start` - run compiled output (`dist/server.js`)
- `npm run lint` - lint TypeScript source

## ngrok Setup (Local Webhook + Telegram Login)

When running locally, Telegram webhook and Telegram login callback need a public HTTPS URL.

1. Start ngrok for local port `3000`
```bash
ngrok http 3000
```

2. Update `.env` using your ngrok domain (example below)
```bash
PUBLIC_BASE_URL=https://your-subdomain.ngrok-free.app
TELEGRAM_BOT_USERNAME=YourTeamAssistantBot
```

3. Set Telegram webhook to your ngrok URL
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://your-subdomain.ngrok-free.app/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

4. Verify webhook status
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Notes:
- If `TELEGRAM_WEBHOOK_SECRET` is set in `.env`, you must send the same value in `setWebhook` (`secret_token`).
- Changing ngrok URL requires re-running `setWebhook`.

## Key Endpoints

- `POST /webhook/telegram` - Telegram updates
- `GET /auth/telegram/gateway` - Telegram login page for Gateway UI
- `GET /auth/telegram/callback` - Telegram login callback
- `GET /admin` - Admin login
- `GET /admin/dashboard` - Admin dashboard
- `GET /health` - Health check

## Environment Notes

- Telegram bot username is not fixed; use any bot created in BotFather and set its token in `TELEGRAM_BOT_TOKEN`.
- `OPENCLAW_API_KEY` is required (container OpenClaw gateway token/auth).
- `BRAVE_API_KEY` is optional; if set, it is injected into user containers.
- `ELEVENLABS_API_KEY` (or `XI_API_KEY`) enables:
  - voice message transcription (Telegram -> text)
  - TTS voice replies via OpenClaw `tts.convert`
- `OPENAI_API_KEY` is optional fallback for voice transcription and OpenClaw TTS fallback provider.
- LiteLLM mode (`LITELLM_ENABLED=true`) provisions one virtual key per assistant bot and maps all keys to the same Telegram owner as a shared LiteLLM `user_id`.
- In LiteLLM mode you must set:
  - `LITELLM_BASE_URL`
  - `LITELLM_CONTAINER_BASE_URL`
  - `LITELLM_MASTER_KEY`
  - `LITELLM_KEY_ENCRYPTION_SECRET`
- Assistant container `openclaw.json` is auto-synced to use `models.providers.litellm` and default model `litellm/<id>`.
- `LITELLM_OPENCLAW_DEFAULT_MODEL` controls the default `litellm/<id>` model in container config.
- `LITELLM_BASE_URL` is used by this service (key provisioning/billing sync); `LITELLM_CONTAINER_BASE_URL` is written into assistant `openclaw.json` for model traffic.
- In LiteLLM mode, assistant containers only receive `LITELLM_API_KEY` (virtual key); upstream provider keys like `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `ANTHROPIC_API_KEY` are not injected.
- LiteLLM spend is synced on an interval (`LITELLM_SYNC_INTERVAL_MS`) and can be manually refreshed from Admin Dashboard.
- `TELEGRAM_BOT_USERNAME` is used by the Telegram login widget for Gateway UI web auth.
- Container ports are allocated from `CONTAINER_PORT_START` to `CONTAINER_PORT_END`.
- Docker socket access is required for container lifecycle management.
