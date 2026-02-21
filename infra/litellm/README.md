# LiteLLM Server (Local/Single-Host)

This project includes a LiteLLM proxy profile in root `docker-compose.yml`.

## 1. Required env vars

In `infra/litellm/.env`, keep:

- `SUPABASE_DB_URL=<supabase-postgres-url-with-sslmode-require>`
- `LITELLM_MASTER_KEY=<random-strong-secret>`
- `LITELLM_SALT_KEY=<random-strong-secret>` (required by LiteLLM server container)
- At least one upstream provider key:
  - `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`

In `apps/pinclaw-bot/.env`, keep app-side LiteLLM vars:

- `LITELLM_ENABLED=true`
- `LITELLM_BASE_URL=http://127.0.0.1:4000`
- `LITELLM_CONTAINER_BASE_URL=http://host.docker.internal:4000`
- `LITELLM_MASTER_KEY=<same-as-infra-litellm-env>`
- `LITELLM_KEY_ENCRYPTION_SECRET=<random-strong-secret>`
- `LITELLM_OPENCLAW_DEFAULT_MODEL=<model-id>` (optional, default `claude-opus-4-6`)

`docker-compose` LiteLLM service now reads only `infra/litellm/.env`.

## 2. Start LiteLLM

```bash
npm run litellm:restart
```

If a historical local helper DB container exists, remove it once:

```bash
npm run litellm:cleanup-local-db
```

## 3. Verify server

```bash
curl -sS http://localhost:4000/v1/models \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

## 4. Verify key generation

```bash
curl -sS -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "1",
    "key_alias": "claw-assistant-smoke",
    "max_budget": 5
  }'
```

## 5. Model routing config

Model aliases are defined in `infra/litellm/litellm_config.yaml`.
Update this file if you want different model names or providers.
