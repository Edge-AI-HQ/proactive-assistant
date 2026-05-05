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

# dotenvx for runtime secret decryption (matches apis Dockerfile pattern).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -sfS https://dotenvx.sh/install.sh | sh \
    && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.venv /app/.venv
COPY src ./src

# Encrypted .env files (decrypted at runtime via DOTENV_PRIVATE_KEY_*).
COPY .env.dev .env.production* ./

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/src

EXPOSE 8000

# DEPLOY_ENV selects which .env file to decrypt at startup (dev or production).
ARG DEPLOY_ENV=dev
ENV DEPLOY_ENV=${DEPLOY_ENV}
CMD ["sh", "-c", "exec dotenvx run -f .env.${DEPLOY_ENV} -- uvicorn pinai_agents.main:app --host 0.0.0.0 --port 8000"]
