# LiteLLM Server (Local/Single-Host)

This project includes a LiteLLM proxy + Postgres deployment profile in root `docker-compose.yml`.

## 1. Required env vars

Set these in your root `.env`:

- `LITELLM_ENABLED=true`
- `LITELLM_MASTER_KEY=<random-strong-secret>`
- `LITELLM_SALT_KEY=<random-strong-secret>`
- `LITELLM_KEY_ENCRYPTION_SECRET=<random-strong-secret>`
- `LITELLM_OPENCLAW_DEFAULT_MODEL=<model-id>` (optional, default `claude-opus-4-6`)
- At least one upstream provider key:
  - `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`

Optional DB vars:

- `LITELLM_POSTGRES_USER` (default `litellm`)
- `LITELLM_POSTGRES_PASSWORD` (default `litellm_change_me`)
- `LITELLM_POSTGRES_DB` (default `litellm`)

If `pin-ai-assistant` runs in Docker Compose together with LiteLLM, service DNS is used by default:

- `LITELLM_BASE_URL_IN_DOCKER=http://litellm:4000`

If app runs on host machine, keep:

- `LITELLM_BASE_URL=http://127.0.0.1:4000`

For assistant OpenClaw containers (model traffic path), set a container-reachable URL:

- `LITELLM_CONTAINER_BASE_URL=http://host.docker.internal:4000`

## 2. Start LiteLLM + DB

```bash
docker compose --profile litellm up -d litellm-db litellm
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
    "user_id": "pinai-user-smoke",
    "key_alias": "pinai-assistant-smoke",
    "max_budget": 5
  }'
```

## 5. Model routing config

Model aliases are defined in `litellm/litellm_config.yaml`.
Update this file if you want different model names or providers.
