# pinai-agents Python service
# Multi-stage: build deps with uv, slim runtime image.
# Mirrors the apis/Dockerfile pattern (multi-stage + dotenvx for runtime secrets).

# ── Stage 1: install deps via uv ──
FROM python:3.12-slim AS builder

# uv: fast Python package manager (https://docs.astral.sh/uv/)
COPY --from=ghcr.io/astral-sh/uv:0.5.4 /uv /uvx /bin/

WORKDIR /app

# uv install non-project deps first (layer cache friendly).
COPY pyproject.toml uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev || uv sync --no-install-project --no-dev

COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev || uv sync --no-dev

# ── Stage 2: runtime ──
FROM python:3.12-slim

WORKDIR /app

COPY --from=builder /app/.venv /app/.venv
COPY src ./src

# Migration runner inputs: yoyo.ini config + db/migrations/ SQL files.
# Used by fly release_command and by the db-migrate compose service.
COPY yoyo.ini ./
COPY db ./db

# pinai_sdk source — copied into image so chat/tools/sandbox.py's
# Image.add_local_dir(/app/packages/pinai_sdk) resolves at runtime when
# we build the Daytona sandbox image.
COPY packages ./packages

# Secret loading is OUTSIDE the image:
#   * docker-compose dev: env_file: ./pinai-agents/.env (web) | .env.chat (chat)
#     Each process group sees only its scoped subset of secrets — chat
#     never gets master credentials. Trust boundary is enforced by
#     env_file selection, not by an in-image dotenvx wrapper.
#   * Fly prod: `flyctl secrets set --process-group=web ...` / chat-only
#     scoping. Same trust boundary, scoped at the platform layer.
#
# Removed the previous `COPY .env.dev .env.production*` + dotenvx CMD
# wrapper. Baking encrypted env files into the image leaked master creds
# into chat at runtime (dotenvx run loaded the full file regardless of
# the env_file scope). Fly secrets per process group is the right
# answer for prod.

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/src

EXPOSE 8000 8001

# Same image, two process groups (see docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx
# § 部署形态). docker-compose / fly.toml override these ENVs to switch:
#
#   web:  ENTRYPOINT_MODULE=pinai_agents.web.asgi:app    ENTRYPOINT_PORT=8000
#   chat: ENTRYPOINT_MODULE=pinai_agents.chat.asgi:app   ENTRYPOINT_PORT=8001
#
# Defaults below pick the web entrypoint so a bare `docker run` still gives
# a useful service.
ENV ENTRYPOINT_MODULE=pinai_agents.web.asgi:app
ENV ENTRYPOINT_PORT=8000
CMD ["sh", "-c", "exec uvicorn ${ENTRYPOINT_MODULE} --host 0.0.0.0 --port ${ENTRYPOINT_PORT}"]
