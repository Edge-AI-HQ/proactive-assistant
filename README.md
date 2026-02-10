# PIN AI Assistant

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

## TypeScript Workflow

- `npm run dev` - run with `tsx` from source (`src/server.ts`)
- `npm run type-check` - strict type check without emit
- `npm run build` - compile TypeScript to `dist/`
- `npm start` - run compiled output (`dist/server.js`)
- `npm run lint` - lint TypeScript source

## ngrok Setup (Local Webhook + OAuth)

When running locally, Telegram webhook and Google OAuth callback need a public HTTPS URL.

1. Start ngrok for local port `3000`
```bash
ngrok http 3000
```

2. Update `.env` using your ngrok domain (example below)
```bash
PUBLIC_BASE_URL=https://your-subdomain.ngrok-free.app
GOOGLE_CALLBACK_URL=https://your-subdomain.ngrok-free.app/auth/google/callback
```

3. In Google Cloud Console, OAuth Client -> Authorized redirect URIs, add exactly:
```text
https://your-subdomain.ngrok-free.app/auth/google/callback
```
`invalid_grant` is almost always caused by mismatch here.

4. Set Telegram webhook to your ngrok URL
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://your-subdomain.ngrok-free.app/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

5. Verify webhook status
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Notes:
- If `TELEGRAM_WEBHOOK_SECRET` is set in `.env`, you must send the same value in `setWebhook` (`secret_token`).
- Changing ngrok URL requires re-running `setWebhook` and updating Google redirect URI.

## Key Endpoints

- `POST /webhook/telegram` - Telegram updates
- `GET /auth/google` - OAuth entry
- `GET /auth/google/callback` - OAuth callback
- `GET /admin` - Admin login
- `GET /admin/dashboard` - Admin dashboard
- `GET /admin/auth` - Admin auth allowlist settings
- `GET /health` - Health check

## Environment Notes

- Telegram bot username is not fixed; use any bot created in BotFather and set its token in `TELEGRAM_BOT_TOKEN`.
- `OPENCLAW_API_KEY` is required (container OpenClaw gateway token/auth).
- `BRAVE_API_KEY` is optional; if set, it is injected into user containers.
- `ELEVENLABS_API_KEY` (or `XI_API_KEY`) enables:
  - voice message transcription (Telegram -> text)
  - TTS voice replies via OpenClaw `tts.convert`
- `OPENAI_API_KEY` is optional fallback for voice transcription and OpenClaw TTS fallback provider.
- `AUTH_ALLOWED_DOMAINS` controls default allowed email domains (comma-separated), default is `pinai.io`.
- `AUTH_ALLOWED_EMAILS` controls default allowed full email addresses (comma-separated).
- Admin can add/remove extra allowed domains and emails in `/admin/auth` without redeploy.
- Container ports are allocated from `CONTAINER_PORT_START` to `CONTAINER_PORT_END`.
- Docker socket access is required for container lifecycle management.
